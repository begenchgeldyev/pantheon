"""Bounded supported-CLI adapter. No native reads or sends occur on import.

Only normalized, allowlisted evidence leaves this module. A send acknowledgement
means platform acceptance, never recipient display/read. Callers must persist a
dispatch attempt *before* calling send_owner; this adapter never retries.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math
import os
import re
import selectors
import signal
import subprocess
import time


@dataclass(frozen=True)
class NativeError:
    category: str
    pre_dispatch: bool = False


@dataclass(frozen=True)
class ReadResult:
    source: str
    observed_at: str
    available: bool
    records: tuple = ()
    complete: bool = False
    gaps: tuple = ()
    error: NativeError | None = None


@dataclass(frozen=True)
class SendResult:
    outcome: str
    evidence: str = 'none'
    retry_safe: bool = False
    error: NativeError | None = None


class _Failure(Exception):
    def __init__(self, category, pre_dispatch=False):
        self.error = NativeError(category, pre_dispatch)
        super().__init__(category)


_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}\Z')


def _identifier(value):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise _Failure('schema_drift')
    return value


def _integer(value):
    return type(value) is int and value >= 0


def _now():
    return datetime.now(timezone.utc).isoformat()


def normalize_run(raw: dict) -> dict:
    """Normalize one cron wire entry; malformed identity/time rejects the row."""
    if not isinstance(raw, dict):
        raise _Failure('schema_drift')
    job_id = _identifier(raw.get('jobId'))
    run_id = _identifier(raw['runId']) if raw.get('runId') is not None else None
    started = raw.get('runAtMs')
    timestamp = raw.get('ts')
    if not _integer(timestamp) or (started is not None and not _integer(started)):
        raise _Failure('schema_drift')
    if run_id is None and started is None:
        raise _Failure('schema_drift')
    status = raw.get('status')
    if any(key in raw and not isinstance(raw[key], str)
           for key in ('status', 'deliveryStatus', 'completionStatus', 'deliverySuppressionReason', 'error', 'deliveryError')):
        raise _Failure('schema_drift')
    if 'delivered' in raw and type(raw['delivered']) is not bool:
        raise _Failure('schema_drift')
    expected_skip = status == 'skipped' and raw.get('error') == 'empty-heartbeat-file'
    processing = {'ok': 'succeeded', 'error': 'failed', 'skipped': 'skipped',
                  'accepted': 'pending', 'in_flight': 'pending'}.get(status, 'unknown')
    if (raw.get('error') and not expected_skip) or raw.get('ok') is False:
        processing = 'failed'
    delivery = {'delivered': 'sent', 'not-delivered': 'failed',
                'not-requested': 'not_requested', 'unknown': 'unknown'}.get(
                    raw.get('deliveryStatus'), 'unknown')
    if raw.get('deliveryError'):
        delivery = 'failed'
    elif delivery == 'failed' and raw.get('deliverySuppressionReason'):
        delivery = 'suppressed'
    elif raw.get('delivered') is False and delivery == 'sent':
        delivery = 'unknown'
    completion = raw.get('completionStatus', 'unknown')
    if completion not in ('succeeded', 'failed', 'unknown'):
        completion = 'unknown'
    # Native overall completion can fail for a delivery requirement independently
    # of agent processing. Expected empty heartbeat skips remain informational.
    if processing == 'failed' or (status == 'skipped' and not expected_skip):
        completion = 'failed'
    return {
        'identity': run_id if run_id is not None else f'cron:{job_id}:{started}',
        'run_id': run_id, 'job_id': job_id,
        'agent_id': _identifier(raw['agentId']) if raw.get('agentId') is not None else None,
        'timestamp_ms': timestamp, 'started_at_ms': started,
        'processing': processing, 'delivery': delivery,
        'completion': completion,
        'informational': expected_skip and processing == 'skipped' and delivery not in ('failed', 'partial_failed'),
        # Processing completion does not retire unresolved delivery settlement.
        # Conversely, an explicit failure is terminal even if another dimension
        # has not settled or has unknown processing evidence.
        'terminal': (processing == 'failed' or delivery in ('failed', 'partial_failed') or
                     completion == 'failed' or expected_skip or
                     (processing == 'succeeded' and delivery in ('sent', 'suppressed', 'not_requested'))),
        'delivery_evidence': 'native_cron_projection' if delivery == 'sent' else 'none',
        'error_category': 'processing_failed' if processing == 'failed' else (
            'delivery_failed' if delivery == 'failed' else None),
    }


def parse_send_result(raw: dict, *, expected_target: str | None = None) -> SendResult:
    """Parse installed message CLI builder shape, not the agent-turn envelope."""
    if not isinstance(raw, dict):
        return SendResult('unknown', error=NativeError('schema_drift'))
    # Inspect only documented receipt containers; never expose their raw contents.
    nodes = [raw]
    payload = raw.get('payload')
    if isinstance(payload, dict):
        nodes.append(payload)
        if isinstance(payload.get('result'), dict):
            nodes.append(payload['result'])
        if isinstance(payload.get('results'), list):
            nodes.extend(n for n in payload['results'] if isinstance(n, dict))
    statuses = [n.get(key) for n in nodes for key in ('deliveryStatus', 'status')]
    if any(n.get('sentBeforeError') is True for n in nodes) or 'partial_failed' in statuses:
        return SendResult('partial_failed', error=NativeError('partial_send'))
    if any(n.get('ok') is False or n.get('error') for n in nodes) or 'failed' in statuses:
        return SendResult('failed', error=NativeError('send_failed'))
    if 'suppressed' in statuses:
        return SendResult('suppressed', error=NativeError('send_suppressed'))
    if any(n.get('queued') is True or n.get('status') == 'queued' for n in nodes):
        return SendResult('queued')
    if any(status is not None and status not in ('sent', 'ok', 'completed') for status in statuses):
        return SendResult('unknown', error=NativeError('unrecognized_receipt'))
    if raw.get('action') != 'send' or raw.get('channel') != 'telegram' or raw.get('dryRun') is not False:
        return SendResult('unknown', error=NativeError('receipt_mismatch'))
    ids = []
    for node in nodes:
        if 'channel' in node and node['channel'] != 'telegram':
            return SendResult('unknown', error=NativeError('receipt_mismatch'))
        # An explicit username may resolve to a numeric chat ID, so only compare
        # numeric destinations directly. Destination IDs are never send evidence.
        if expected_target is not None:
            for key in ('target', 'to'):
                if key in node and node[key] != expected_target:
                    return SendResult('unknown', error=NativeError('receipt_mismatch'))
            chat = expected_target.split(':topic:', 1)[0]
            if re.fullmatch(r'-?[0-9]+', chat) and 'chatId' in node and str(node['chatId']) != chat:
                return SendResult('unknown', error=NativeError('receipt_mismatch'))
        if 'messageId' in node:
            value = node['messageId']
            if not isinstance(value, str) or not _ID.fullmatch(value):
                return SendResult('unknown', error=NativeError('invalid_receipt'))
            ids.append(value)
    if len(set(ids)) == 1:
        return SendResult('sent', 'provider_message_id')
    return SendResult('unknown', error=NativeError('unproven_send'))


class NativeAdapter:
    def __init__(self, executable=('openclaw',), *, timeout=10.0,
                 max_output_bytes=1048576):
        """executable is a fixed argv prefix (a string also means one executable)."""
        if isinstance(executable, str):
            executable = (executable,)
        if (not isinstance(executable, (tuple, list)) or not executable or
                any(not isinstance(s, str) or not s or '\0' in s for s in executable)):
            raise ValueError('invalid executable')
        if (isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or
                not math.isfinite(timeout) or not 0 < timeout <= 120):
            raise ValueError('invalid timeout')
        if type(max_output_bytes) is not int or not 1 <= max_output_bytes <= 8388608:
            raise ValueError('invalid output limit')
        self.executable = tuple(executable)
        self.timeout = timeout
        self.max_output_bytes = max_output_bytes

    def _json(self, args, *, failure_envelope=False):
        # Concurrent bounded draining prevents stdout/stderr deadlocks. Kill the
        # fixture/native process group on timeout/overflow, including pipe holders.
        try:
            proc = subprocess.Popen([*self.executable, *args], stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    start_new_session=True)
        except (FileNotFoundError, PermissionError):
            raise _Failure('executable_unavailable', True) from None
        except OSError:
            raise _Failure('spawn_failed', True) from None
        output = bytearray()
        size = 0
        deadline = time.monotonic() + self.timeout
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(proc.stdout, selectors.EVENT_READ, True)
                selector.register(proc.stderr, selectors.EVENT_READ, False)
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise _Failure('timeout')
                    for key, _ in selector.select(remaining):
                        chunk = os.read(key.fileobj.fileno(), 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        size += len(chunk)
                        if size > self.max_output_bytes:
                            raise _Failure('output_limit')
                        if key.data:
                            output.extend(chunk)
                try:
                    code = proc.wait(timeout=max(.001, deadline - time.monotonic()))
                except subprocess.TimeoutExpired:
                    raise _Failure('timeout') from None
            if code != 0 and not failure_envelope:
                raise _Failure('command_failed')
        finally:
            # Always reap the child; never include argv or stderr in an error.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()
            proc.stdout.close()
            proc.stderr.close()
        try:
            data = json.loads(output.decode('utf-8'))
        except (ValueError, UnicodeError, RecursionError):
            raise _Failure('malformed_json') from None
        if code != 0 and parse_send_result(data).outcome not in ('failed', 'partial_failed', 'suppressed'):
            raise _Failure('command_failed')
        if not failure_envelope and isinstance(data, dict) and data.get('ok') is False:
            raise _Failure('command_failed')
        return data

    def _read(self, source, args, field, normalize):
        observed = _now()
        try:
            raw = self._json(args)
            rows = raw.get(field) if field and isinstance(raw, dict) else raw
            if not isinstance(rows, list) or len(rows) > 10000:
                raise _Failure('schema_drift')
            records = tuple(normalize(row) for row in rows)
            return ReadResult(source, observed, True, records, True)
        except _Failure as failure:
            return ReadResult(source, observed, False, error=failure.error)

    def agents(self) -> ReadResult:
        """Configured CLI roster only; no workspace or template enumeration."""
        def normalize(row):
            if not isinstance(row, dict) or type(row.get('isDefault')) is not bool:
                raise _Failure('schema_drift')
            return {'id': _identifier(row.get('id')), 'is_default': row['isDefault']}
        return self._read('native_agents', ['agents', 'list', '--json'], None, normalize)

    def jobs(self) -> ReadResult:
        def normalize(row):
            if not isinstance(row, dict) or type(row.get('enabled')) is not bool:
                raise _Failure('schema_drift')
            state = row.get('state', {})
            if not isinstance(state, dict):
                raise _Failure('schema_drift')
            running = state.get('runningAtMs')
            if running is not None and not _integer(running):
                raise _Failure('schema_drift')
            return {'id': _identifier(row.get('id')), 'enabled': row['enabled'], 'running_at_ms': running,
                    'agent_id': _identifier(row['agentId']) if row.get('agentId') is not None else None}
        return self._read('native_cron_list', ['cron', 'list', '--all', '--json'], 'jobs', normalize)

    def runs(self, *, page_size=50, max_pages=5, known_run_ids=()) -> ReadResult:
        """Newest-first bounded scan; callers overlap polls using stored identities.

        Missing known identities are possible retention gaps, not proof of loss.
        `complete` means this bounded scan ended without detected gaps, not that
        native history has infinite retention or that offset paging is atomic.
        """
        if type(page_size) is not int or not 1 <= page_size <= 200:
            raise ValueError('invalid page size')
        if type(max_pages) is not int or not 1 <= max_pages <= 100:
            raise ValueError('invalid page count')
        if not isinstance(known_run_ids, (tuple, list, set, frozenset)) or len(known_run_ids) > 20000:
            raise ValueError('invalid history anchors')
        if any(not isinstance(key, str) or len(key) > 600 for key in known_run_ids):
            raise ValueError('invalid history anchors')
        observed = _now()
        records, gaps = {}, set()
        offset, previous_total = 0, None
        try:
            for index in range(max_pages):
                raw = self._json(['cron', 'runs', '--all', '--limit', str(page_size),
                                  '--offset', str(offset), '--sort', 'desc'])
                if (not isinstance(raw, dict) or not isinstance(raw.get('entries'), list) or
                        any(not _integer(raw.get(k)) for k in ('total', 'offset', 'limit')) or
                        type(raw.get('hasMore')) is not bool or
                        not 1 <= raw['limit'] <= 200 or len(raw['entries']) > raw['limit']):
                    raise _Failure('schema_drift')
                if raw['offset'] != offset or (previous_total is not None and raw['total'] != previous_total):
                    gaps.add('pagination_changed')
                for row in raw['entries']:
                    record = normalize_run(row)
                    key = record['identity']
                    if key in records:
                        gaps.add('pagination_overlap')
                        if record != records[key]:
                            gaps.add('run_changed_during_scan')
                    else:
                        records[key] = record
                previous_total = raw['total']
                if not raw['hasMore']:
                    if raw.get('nextOffset') is not None:
                        raise _Failure('schema_drift')
                    if raw['offset'] + len(raw['entries']) != raw['total']:
                        gaps.add('pagination_changed')
                    break
                next_offset = raw.get('nextOffset')
                if (not _integer(next_offset) or next_offset <= offset or
                        next_offset != raw['offset'] + len(raw['entries']) or
                        next_offset >= raw['total']):
                    raise _Failure('schema_drift')
                offset = next_offset
            else:
                gaps.add('page_limit')
            if set(known_run_ids) - records.keys():
                gaps.add('history_anchor_missing')
            return ReadResult('native_cron_runs', observed, True, tuple(records.values()),
                              not gaps, tuple(sorted(gaps)))
        except _Failure as failure:
            gaps.add('source_unavailable')
            return ReadResult('native_cron_runs', observed, False, tuple(records.values()),
                              False, tuple(sorted(gaps)), failure.error)

    def send_owner(self, target: str, message: str) -> SendResult:
        """Send exactly once via configured System Agent; target resolved by caller.

        Only spawn failures prove no dispatch. All post-spawn errors suppress
        automatic retry, including nonzero exits, timeout and malformed receipts.
        """
        if (not isinstance(target, str) or not re.fullmatch(r'[A-Za-z0-9@][A-Za-z0-9_:@+.-]{0,255}', target)):
            # Numeric Telegram IDs can be negative; accept them explicitly.
            if not isinstance(target, str) or not re.fullmatch(r'-[0-9]{1,30}(?::topic:[0-9]{1,20})?', target):
                raise ValueError('invalid owner target')
        if not isinstance(message, str) or not message.strip() or '\0' in message or len(message.encode('utf-8')) > 4096:
            raise ValueError('invalid alert message')
        try:
            raw = self._json(['message', 'send', '--channel', 'telegram', '--target', target,
                              '--message', message, '--json'], failure_envelope=True)
            return parse_send_result(raw, expected_target=target)
        except _Failure as failure:
            return SendResult('unknown', retry_safe=failure.error.pre_dispatch, error=failure.error)
