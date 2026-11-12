"""Protected receipts, conservative native projections, and shell-facing operations.

No raw native output is persisted. A dispatched attempt is never retried implicitly.
"""
import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import uuid

PROCESSING = {'not_started', 'accepted', 'in_flight', 'succeeded', 'failed', 'unknown'}
DELIVERY = {'not_requested', 'sent', 'suppressed', 'partial_failed', 'failed', 'unknown'}


class StateError(ValueError):
    """Invalid durable state or input (safe to report without payload content)."""


def utcnow():
    return dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z')


def valid_date(day):
    try:
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day):
            raise ValueError()
        dt.date.fromisoformat(day)
    except (ValueError, TypeError):
        raise StateError('invalid calendar date') from None
    return day


def classify_agent_result(payload: object, exit_code: int, *, expected_target=None) -> dict:
    processing = dict(status='unknown', run_id=None, started_at=None, finished_at=None)
    delivery = dict(status='unknown', evidence=None, at=None)
    envelopes = []
    malformed = False

    def visit(value, depth=0):
        nonlocal malformed
        if not isinstance(value, dict) or depth > 5:
            malformed = True
            return
        envelopes.append(value)
        for key in ('result', 'data'):
            if key in value:
                visit(value[key], depth + 1)

    visit(payload)
    statuses = []
    deliveries = []
    run_ids = []
    route_bad = False
    for envelope in envelopes:
        if 'status' in envelope:
            statuses.append({'ok': 'succeeded', 'completed': 'succeeded',
                             'accepted': 'accepted', 'in_flight': 'in_flight',
                             'failed': 'failed', 'error': 'failed'}.get(str(envelope['status']), 'unknown'))
        run_id = envelope.get('runId', envelope.get('run_id'))
        if isinstance(run_id, str) and re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}', run_id):
            run_ids.append(run_id)
        if envelope.get('error') or envelope.get('success') is False or envelope.get('ok') is False:
            statuses.append('failed')
        for key in ('channel', 'replyChannel'):
            if key in envelope and envelope[key] != 'telegram':
                route_bad = True
        for key in ('target', 'to', 'replyTo'):
            if expected_target is not None and key in envelope and str(envelope[key]) != str(expected_target):
                route_bad = True
        if 'deliveryStatus' in envelope:
            d = envelope['deliveryStatus']
            if not isinstance(d, dict):
                deliveries.append('unknown')
                continue
            status = d.get('status')
            if not isinstance(status, str) or status not in DELIVERY:
                status = 'unknown'
            if status == 'sent':
                if not all(d.get(k) is True for k in ('requested', 'attempted', 'succeeded')):
                    status = 'unknown'
                for key in ('resultCount', 'succeededCount'):
                    if key in d and (type(d[key]) is not int or d[key] <= 0):
                        status = 'unknown'
                if d.get('error') or d.get('failed') is True or d.get('failedCount', 0) != 0:
                    status = 'unknown'
            if 'channel' in d and d['channel'] != 'telegram':
                route_bad = True
            for key in ('target', 'to', 'replyTo'):
                if expected_target is not None and key in d and str(d[key]) != str(expected_target):
                    route_bad = True
            deliveries.append(status)
    if len(set(run_ids)) == 1:
        processing['run_id'] = run_ids[0]
    if statuses and not malformed:
        if len(set(statuses)) == 1:
            processing['status'] = statuses[0]
        elif 'failed' in statuses:
            processing['status'] = 'failed'
    # An unsuccessful transport cannot establish terminal processing success.
    if exit_code != 0 and processing['status'] == 'succeeded':
        processing['status'] = 'unknown'
    if deliveries and len(set(deliveries)) == 1 and not malformed and not route_bad:
        delivery['status'] = deliveries[0]
        if delivery['status'] != 'unknown':
            delivery['evidence'] = 'native_projection'
    return dict(processing=processing, delivery=delivery)


def state_path(root, day):
    return Path(root) / 'standups' / valid_date(day) / 'state.json'


def load_standup(state_dir: Path, day: str) -> dict | None:
    path = state_path(state_dir, day)
    try:
        value = json.loads(path.read_text())
    except FileNotFoundError:
        return None
    except (ValueError, OSError):
        raise StateError('unreadable or malformed standup state') from None
    if (not isinstance(value, dict) or type(value.get('version')) is not int or value.get('version') != 1 or value.get('date') != day
            or not isinstance(value.get('attempt_id'), str)
            or not isinstance(value.get('summary_sha256'), str)
            or not isinstance(value.get('updated_at'), str)):
        raise StateError('invalid standup state header')
    for key, allowed in (('input', {'stored', 'unknown'}), ('processing', PROCESSING), ('delivery', DELIVERY)):
        obj = value.get(key)
        if (not isinstance(obj, dict) or not isinstance(obj.get('status', 'unknown'), str)
                or obj.get('status', 'unknown') not in allowed):
            raise StateError('invalid standup stage object')
    if not re.fullmatch(r'[0-9a-f]{64}', value['summary_sha256']):
        raise StateError('invalid summary hash')
    for obj, keys in ((value, ('updated_at',)), (value['input'], ('stored_at',)),
                      (value['processing'], ('started_at', 'finished_at')),
                      (value['delivery'], ('at',))):
        for key in keys:
            stamp = obj.get(key)
            if stamp is not None:
                try:
                    if not isinstance(stamp, str):
                        raise ValueError()
                    parsed = dt.datetime.fromisoformat(stamp.replace('Z', '+00:00'))
                    if parsed.utcoffset() != dt.timedelta(0):
                        raise ValueError()
                except (TypeError, ValueError):
                    raise StateError('invalid UTC state timestamp') from None
    for obj, key in ((value['processing'], 'run_id'), (value['delivery'], 'evidence')):
        if obj.get(key) is not None and not isinstance(obj[key], str):
            raise StateError('invalid stage reference')
    # Normalize absent fields for consumers; never infer success.
    for key, defaults in (('input', {'status': 'unknown', 'stored_at': None}),
                          ('processing', {'status': 'unknown', 'run_id': None, 'started_at': None, 'finished_at': None}),
                          ('delivery', {'status': 'unknown', 'evidence': None, 'at': None})):
        value[key] = defaults | value[key]
    return value


def protected_dir(path):
    path = Path(path)
    if not path.exists():
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path, 0o700)
    return path


def atomic_write(path, content, mode=0o600, owner=None):
    path = Path(path)
    protected_dir(path.parent)
    fd, tmp = tempfile.mkstemp(prefix='.new-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fchmod(stream.fileno(), mode)
            if owner:
                os.fchown(stream.fileno(), *owner)
            os.fsync(stream.fileno())
        os.replace(tmp, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def save(root, day, value, owner=None):
    value['updated_at'] = utcnow()
    atomic_write(state_path(root, day), (json.dumps(value, sort_keys=True) + '\n').encode(), owner=owner)


@contextlib.contextmanager
def date_lock(root, day):
    protected_dir(root)
    protected_dir(Path(root) / 'standups')
    directory = protected_dir(state_path(root, day).parent)
    fd = os.open(directory / '.lock', os.O_CREAT | os.O_RDWR, 0o600)
    try:
        os.fchmod(fd, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def initial(day, summary, stored_at=None):
    return dict(version=1, date=day, attempt_id=str(uuid.uuid4()),
                summary_sha256=hashlib.sha256(summary).hexdigest(),
                input=dict(status='stored', stored_at=stored_at or utcnow()),
                processing=dict(status='not_started', run_id=None, started_at=None, finished_at=None),
                delivery=dict(status='unknown', evidence=None, at=None), updated_at=utcnow())


def emit(value):
    print(json.dumps(value, sort_keys=True))


def intake(args):
    valid_date(args.day)
    workspace = Path(args.workspace)
    if not workspace.is_dir():
        return 4
    summary_path = workspace / 'standups' / (args.day + '.md')
    with date_lock(args.root, args.day):
        owner = tuple(map(int, args.owner.split(':'))) if args.owner else None
        if owner:
            for path in (Path(args.root), Path(args.root) / 'standups',
                         state_path(args.root, args.day).parent,
                         state_path(args.root, args.day).parent / '.lock'):
                os.chown(path, *owner)

        def persist(value):
            save(args.root, args.day, value, owner=owner)

        previous = load_standup(Path(args.root), args.day)
        if args.resume:
            if not summary_path.is_file():
                raise StateError('no stored summary to resume')
            summary = summary_path.read_bytes()
        else:
            summary = sys.stdin.buffer.read(65537)
        if len(summary) > 65536 or not summary.strip():
            raise StateError('summary must be nonempty and at most 65536 bytes')
        digest = hashlib.sha256(summary).hexdigest()
        if previous is None and summary_path.exists():
            # Import legacy storage before applying the same explicit retry policy.
            previous = initial(args.day, summary_path.read_bytes(),
                               dt.datetime.fromtimestamp(summary_path.stat().st_mtime, dt.timezone.utc).isoformat())
            previous['legacy'] = True
            previous['processing']['status'] = 'unknown'
            persist(previous)
        if previous:
            changed = digest != previous['summary_sha256']
            if changed and not (args.replace and args.resend):
                raise StateError('changed summary requires --replace --resend')
            if not changed and not args.resend:
                emit(previous)
                return 6 if previous.get('native_exit_code', 0) else 0
        if args.resend:
            print('warning: explicit resend can duplicate an unknown prior outcome', file=sys.stderr)
        stored_at = previous['input']['stored_at'] if previous and previous['summary_sha256'] == digest else None
        value = initial(args.day, summary, stored_at)
        if previous:
            value['previous_attempt_id'] = previous['attempt_id']
        atomic_write(summary_path, summary, 0o600, owner=owner)
        if owner:
            os.chown(summary_path.parent, *owner)
        persist(value)
        message = (f'[standup {args.day}]\nThe morning summary from the laptop, already saved by the intake as '
                   f'standups/{args.day}.md — do not write or change that file. Format only the provided summary '
                   'per AGENTS.md and reply only with the formatted summary; do not add greetings or philosophy. '
                   'Sending is requested; its outcome is observed separately.\n<<<SUMMARY\n').encode()
        message += summary + (b'' if summary.endswith(b'\n') else b'\n') + b'SUMMARY>>>\n'
        # The transient message is readable only by the actual executor's owner.
        with tempfile.TemporaryDirectory() as tmp:
            msgpath = Path(tmp) / 'message'
            msgpath.write_bytes(message)
            msgpath.chmod(0o600)
            if owner:
                os.chown(tmp, *owner)
                os.chown(msgpath, *owner)
            command = args.command
            if command and command[0] == '--':
                command = command[1:]
            command += ['agent', '--agent', 'seneca', '--message-file', str(msgpath), '--deliver',
                        '--reply-channel', 'telegram', '--reply-to', args.chat, '--timeout', '300', '--json']
            value['processing'].update(status='unknown', started_at=utcnow())
            value['dispatch_started'] = True
            persist(value)  # crash after this point is ambiguous, not retryable
            rc = 0
            with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as error:
                try:
                    result = subprocess.run(command, stdout=output, stderr=error, timeout=330)
                    rc = result.returncode
                except subprocess.TimeoutExpired:
                    rc = 124
                except OSError:
                    rc = 127
                output.seek(0)
                raw = output.read(1048577)
            try:
                payload = json.loads(raw) if len(raw) <= 1048576 else None
            except (ValueError, UnicodeError):
                payload = None
            parsed = classify_agent_result(payload, rc, expected_target=args.chat)
            parsed['processing']['started_at'] = value['processing']['started_at']
            if parsed['processing']['status'] in ('succeeded', 'failed'):
                parsed['processing']['finished_at'] = utcnow()
            if parsed['delivery']['status'] != 'unknown':
                parsed['delivery']['at'] = utcnow()
            value.update(parsed)
            value['error_category'] = 'native_exit' if rc else None
            value['native_exit_code'] = rc
            persist(value)
            emit(value)
            return 6 if rc else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', dest='root', default=os.environ.get('PANTHEON_STATE_DIR', '/home/openclaw/.local/state/pantheon'))
    sub = parser.add_subparsers(dest='verb', required=True)
    status = sub.add_parser('status')
    status.add_argument('day')
    status.add_argument('--workspace')
    incoming = sub.add_parser('intake')
    incoming.add_argument('day')
    incoming.add_argument('--workspace', required=True)
    incoming.add_argument('--chat', required=True)
    incoming.add_argument('--owner')
    for flag in ('resume', 'replace', 'resend'):
        incoming.add_argument('--' + flag, action='store_true')
    # Executor argv is supplied as repeated arguments, not interpreted by a shell.
    incoming.add_argument('--exec-arg', action='append', dest='command', default=[])
    local = sub.add_parser('local-stage')
    local.add_argument('day')
    local.add_argument('stage', choices=['started', 'collected', 'generated', 'submitting', 'submitted', 'submission_unknown', 'failed'])
    local.add_argument('--window')
    local.add_argument('--category', choices=['collect', 'skill', 'prompt', 'opencode', 'summary', 'ssh', 'intake', 'tmp'])
    args = parser.parse_args()
    try:
        valid_date(args.day)
        if args.verb == 'status':
            value = load_standup(Path(args.root), args.day)
            if value is None and args.workspace:
                path = Path(args.workspace) / 'standups' / (args.day + '.md')
                if path.is_file():
                    value = initial(args.day, path.read_bytes(), dt.datetime.fromtimestamp(path.stat().st_mtime, dt.timezone.utc).isoformat())
                    value['attempt_id'] = 'legacy'
                    value['processing']['status'] = 'unknown'
                    value['legacy'] = True
            emit(value)
        elif args.verb == 'intake':
            if not args.command:
                raise StateError('missing native executor')
            return intake(args)
        else:
            # The laptop shell holds its per-date lock across the entire pipeline.
            value = load_standup(Path(args.root), args.day)
            if value is None:
                value = initial(args.day, b'')
                value['input'] = dict(status='unknown', stored_at=None)
            laptop = value.setdefault('laptop', {})
            laptop.setdefault('collection_completed', False)
            laptop.setdefault('generation_completed', False)
            laptop.setdefault('submission_status', 'not_started')
            if args.stage == 'started':
                laptop.setdefault('started', utcnow())
            else:
                laptop[args.stage] = utcnow()
            if args.window:
                laptop['collection_window'] = args.window
            if args.category:
                laptop['error_category'] = args.category
                if args.category == 'intake':
                    laptop['submission_status'] = 'failed'
            if args.stage == 'generated':
                summary = state_path(args.root, args.day).parent / 'summary'
                with summary.open('rb') as stream:
                    content = stream.read(65537)
                    if len(content) > 65536 or not content.strip():
                        raise StateError('invalid generated summary')
                    os.fsync(stream.fileno())
                value['summary_sha256'] = hashlib.sha256(content).hexdigest()
                laptop['generation_completed'] = True
            elif args.stage == 'collected':
                laptop['collection_completed'] = True
            elif args.stage in ('submitting', 'submitted', 'submission_unknown'):
                laptop['submission_status'] = {'submitting': 'in_flight', 'submitted': 'submitted',
                                               'submission_unknown': 'unknown'}[args.stage]
            save(args.root, args.day, value)
    except (StateError, OSError) as error:
        print('pantheon-state: ' + (str(error) if isinstance(error, StateError) else 'state I/O unavailable'), file=sys.stderr)
        return 2
    return 0
