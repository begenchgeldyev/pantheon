"""Read-only status and explicitly initialized, non-model owner alert checker."""
import argparse
from contextlib import contextmanager
from dataclasses import asdict, dataclass
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
from zoneinfo import ZoneInfo

try:
    from .native import NativeAdapter
    from .state import StateError, atomic_write, load_standup, valid_date
except ImportError:
    from native import NativeAdapter
    from state import StateError, atomic_write, load_standup, valid_date

TOMSK = ZoneInfo('Asia/Tomsk')
UTC = dt.timezone.utc
MAX_ITEMS = 20000
MAX_ALERTS = 4096
MAX_DISPATCH_PER_CHECK = 5
CONDITIONS = {'missing_input', 'standup_incomplete', 'standup_failed', 'native_failure'}
OUTCOMES = {'dispatching', 'sent', 'queued', 'unknown', 'failed', 'partial_failed', 'suppressed'}
ERROR_CATEGORIES = {'executable_unavailable', 'spawn_failed', 'timeout', 'output_limit',
                    'command_failed', 'malformed_json', 'schema_drift', 'partial_send',
                    'send_failed', 'send_suppressed', 'unrecognized_receipt',
                    'receipt_mismatch', 'invalid_receipt', 'unproven_send'}
CHECK_ERRORS = {'owner_unavailable', 'monitor_capacity', 'dispatch_limit'}


@dataclass(frozen=True)
class Config:
    state_dir: Path = Path('/home/openclaw/.local/state/pantheon')
    workspace: Path = Path('/home/openclaw/.openclaw/workspace-seneca')
    owner_file: Path = Path('/home/openclaw/bin/remind-impl/owner-chat')
    executable: str = 'openclaw'
    timeout: float = 10.0
    page_size: int = 50
    max_pages: int = 5
    excluded_dates: tuple = ()
    pause_until: str | None = None
    since: str | None = None
    until: str | None = None

    def __post_init__(self):
        if type(self.page_size) is not int or not 1 <= self.page_size <= 200:
            raise ValueError('invalid page size')
        if type(self.max_pages) is not int or not 1 <= self.max_pages <= 100:
            raise ValueError('invalid page count')
        if not isinstance(self.excluded_dates, tuple) or len(self.excluded_dates) > 3660:
            raise ValueError('invalid excluded dates')
        for day in self.excluded_dates:
            valid_date(day)
        if self.pause_until is not None:
            valid_date(self.pause_until)
        for day in (self.since, self.until):
            if day is not None:
                valid_date(day)
        if self.since is not None and self.until is not None:
            _range_dates(self.since, self.until)
        NativeAdapter(self.executable, timeout=self.timeout)


def _clock(now):
    now = now or dt.datetime.now(UTC)
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError('clock must have timezone')
    return now.astimezone(TOMSK)


def _stamp(value):
    return value.astimezone(UTC).isoformat()


def _parse(value):
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError('invalid timestamp')
    return parsed


def _hash(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def _protected(path, directory=False):
    info = path.lstat()
    if (info.st_uid != os.getuid() or info.st_mode & 0o077 or
            not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))):
        raise StateError('unsafe monitor storage')


def _load(config):
    path = config.state_dir/'monitor/state.json'
    try:
        _protected(path.parent, True)
        _protected(path)
        with path.open('rb') as stream:
            raw = stream.read(8388609)
        if len(raw) > 8388608:
            raise ValueError()
        value = json.loads(raw)
        if (not isinstance(value, dict) or type(value.get('version')) is not int or value['version'] != 1 or
                not isinstance(value.get('coverage_start'), str) or
                not isinstance(value.get('baseline_at'), str)):
            raise ValueError()
        valid_date(value['coverage_start']); _parse(value['baseline_at'])
        if type(value.get('watermark_ms')) is not int or value['watermark_ms'] < 0:
            raise ValueError()
        if value.get('last_check_error') is not None and value['last_check_error'] not in CHECK_ERRORS:
            raise ValueError()
        if value.get('last_check_at') is not None:
            _parse(value['last_check_at'])
        for key in ('seen', 'pending', 'anchors'):
            rows = value.get(key)
            if (not isinstance(rows, list) or len(rows) > MAX_ITEMS or
                    any(not isinstance(row, str) or len(row) > 600 for row in rows)):
                raise ValueError()
        alerts = value.get('alerts')
        if not isinstance(alerts, dict) or len(alerts) > MAX_ALERTS:
            raise ValueError()
        for key, alert in alerts.items():
            if (not re.fullmatch('[0-9a-f]{64}', key) or not isinstance(alert, dict) or
                    alert.get('condition') not in CONDITIONS or alert.get('outcome') not in OUTCOMES or
                    type(alert.get('count')) is not int or not 1 <= alert['count'] <= 3 or
                    type(alert.get('retry_safe')) is not bool):
                raise ValueError()
            if (not isinstance(alert.get('attempt'), str) or not re.fullmatch(r'(?:[0-9a-f]{64}|\d{4}-\d{2}-\d{2})', alert['attempt']) or
                    (alert.get('error_category') is not None and alert['error_category'] not in ERROR_CATEGORIES)):
                raise ValueError()
            if alert.get('retry_at') is not None:
                _parse(alert['retry_at'])
            elif alert['retry_safe']:
                raise ValueError()
            if 'reference' in alert and (not isinstance(alert['reference'], str) or
                                          not re.fullmatch(r'(?:run|standup)-[0-9a-f]{12}', alert['reference'])):
                raise ValueError()
            if 'dimension' in alert and alert['dimension'] not in ('processing', 'delivery', 'completion', 'input', 'unknown'):
                raise ValueError()
            if 'date' in alert:
                valid_date(alert['date'])
            if alert.get('run_observed_at') is not None:
                _parse(alert['run_observed_at'])
        return value
    except FileNotFoundError:
        return None
    except (OSError, ValueError, TypeError, RecursionError):
        raise StateError('monitor state unavailable') from None


@contextmanager
def _lock(config):
    # No writes in build_status. Checker exclusively owns these protected files.
    root = config.state_dir
    if not root.exists():
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise StateError('unsafe monitor root')
    # Lifecycle atomic_write can have created intermediate parents with umask
    # defaults. Tighten this shared state root without changing lifecycle files.
    root.chmod(0o700)
    _protected(root, True)
    directory = root/'monitor'
    directory.mkdir(mode=0o700, exist_ok=True)
    _protected(directory, True)
    fd = os.open(directory/'.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise StateError('unsafe monitor lock')
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def _save(config, value):
    if (len(value['seen']) > MAX_ITEMS or len(value['pending']) > MAX_ITEMS or
            len(value['alerts']) > MAX_ALERTS):
        raise StateError('monitor capacity reached')
    atomic_write(config.state_dir/'monitor/state.json', (json.dumps(value, sort_keys=True)+'\n').encode())


def _standup(config, day):
    base = dict(available=True, storage='missing', input='missing', stored_at=None,
                processing='unknown', delivery='unknown', attempt=None,
                reference='standup-'+_hash(day)[:12])
    try:
        value = load_standup(config.state_dir, day)
        if value is not None:
            base.update(storage='stored' if value['input']['status'] == 'stored' else 'unknown',
                        input=value['input']['status'], stored_at=value['input']['stored_at'],
                        processing=value['processing']['status'], delivery=value['delivery']['status'],
                        attempt=_hash(day+':'+value['attempt_id']))
            base['reference'] = 'standup-'+_hash(base['attempt'])[:12]
            if value.get('legacy'):
                base['storage'] = 'legacy_stored_only'
            return base
        # A legacy summary's content is never opened, hashed, or included.
        path = config.workspace/'standups'/(day+'.md')
        try:
            info = path.lstat()
        except FileNotFoundError:
            return base
        if not stat.S_ISREG(info.st_mode):
            raise StateError('invalid legacy storage')
        base.update(storage='legacy_stored_only', input='stored', attempt=_hash(day+':legacy'),
                    stored_at=dt.datetime.fromtimestamp(info.st_mtime, UTC).isoformat())
        base['reference'] = 'standup-'+_hash(base['attempt'])[:12]
        return base
    except (StateError, OSError, ValueError):
        return dict(base, available=False, input='unknown', storage='unknown', error='standup_unavailable')


def _range_dates(since, until):
    start, end = dt.date.fromisoformat(since), dt.date.fromisoformat(until)
    if not 0 <= (end-start).days < 366:
        raise ValueError('coverage range must be ordered and at most 366 days')
    return start, end


def _coverage(config, monitor, now, today_standup):
    default_start = monitor['coverage_start'] if monitor else now.date().isoformat()
    since, until = config.since or default_start, config.until or now.date().isoformat()
    start, end = dt.date.fromisoformat(since), dt.date.fromisoformat(until)
    gaps, omitted = [], None
    if config.since is None and config.until is None and (end-start).days >= 366:
        start = end-dt.timedelta(days=365)
        gaps.append('range_truncated')
        omitted = dict(since=since, until=(start-dt.timedelta(days=1)).isoformat())
    _range_dates(start.isoformat(), end.isoformat())
    counts = dict(days=0, expected=0, expected_unknown=0, due=0, received=0,
                  stored_only=0, missing=0, source_unavailable=0, sent=0,
                  processing_failed=0, delivery_failed=0, processing_unknown=0, delivery_unknown=0)
    days, missing, unavailable = [], [], []
    for index in range((end-start).days+1):
        date = start+dt.timedelta(days=index)
        day = date.isoformat()
        observed = today_standup if date == now.date() else _standup(config, day)
        monitored = monitor is not None and day >= monitor['coverage_start']
        policy_expected = date.weekday() < 5 and day not in config.excluded_dates and (config.pause_until is None or day > config.pause_until)
        expected = policy_expected if monitored else None
        due = expected and now >= dt.datetime.combine(date, dt.time(7, 30), TOMSK) if monitored else None
        received = ('unknown' if not observed['available'] or observed['input'] == 'unknown'
                    else 'stored' if observed['input'] == 'stored' else 'missing')
        missing_due = due is True and received == 'missing'
        row = dict(date=day, monitoring='monitored' if monitored else 'not_monitored',
                   expected=expected, due=due, current_policy_expected=policy_expected,
                   scheduled_at=dt.datetime.combine(date, dt.time(7), TOMSK).isoformat(),
                   input_deadline=dt.datetime.combine(date, dt.time(7, 30), TOMSK).isoformat(),
                   received=received, missing_due=missing_due, **observed)
        days.append(row)
        counts['days'] += 1
        counts['expected'] += expected is True
        counts['expected_unknown'] += expected is None
        counts['due'] += due is True
        counts['received'] += received == 'stored'
        counts['stored_only'] += observed['storage'] == 'legacy_stored_only'
        counts['missing'] += missing_due
        counts['source_unavailable'] += not observed['available']
        counts['sent'] += observed['delivery'] == 'sent'
        counts['processing_failed'] += observed['processing'] == 'failed'
        counts['delivery_failed'] += observed['delivery'] in ('failed', 'partial_failed', 'suppressed')
        counts['processing_unknown'] += observed['processing'] == 'unknown'
        counts['delivery_unknown'] += observed['delivery'] == 'unknown'
        if missing_due:
            missing.append(day)
        if not observed['available']:
            unavailable.append(day)
    if unavailable:
        gaps.append('standup_source_unavailable')
    if monitor is None:
        gaps.append('monitoring_start_unknown')
    return dict(since=start.isoformat(), until=end.isoformat(), requested_since=since,
                requested_until=until, omitted_range=omitted, complete=not gaps, gaps=gaps,
                activation_date=monitor['coverage_start'] if monitor else None,
                policy=dict(basis='current_policy_assumption_not_maintenance_history',
                            timezone='Asia/Tomsk', weekdays=[0, 1, 2, 3, 4], expected_at='07:00',
                            input_deadline='07:30', incomplete_deadline='07:45',
                            late_input_grace_minutes=15, excluded_dates=list(config.excluded_dates),
                            pause_until=config.pause_until),
                counts=counts, missing_dates=missing, unavailable_dates=unavailable, days=days)


def _ms_stamp(value):
    try:
        return dt.datetime.fromtimestamp(value/1000, UTC).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def _run_attempt(row):
    return _hash(_alias(row) or row['identity'])


def _dimension(row):
    if row.get('informational', False):
        return 'none'
    if row['processing'] == 'failed':
        return 'processing'
    if row['delivery'] in ('failed', 'partial_failed'):
        return 'delivery'
    if row.get('completion') == 'failed':
        return 'completion'
    return 'none'


def _settled(row):
    return (_dimension(row) != 'none' or row.get('informational', False) or
            (row['processing'] == 'succeeded' and row['delivery'] in ('sent', 'suppressed', 'not_requested')))


def _run_evidence(row, monitor):
    baseline_ms = int(_parse(monitor['baseline_at']).timestamp()*1000) if monitor else None
    started = row['started_at_ms']
    return dict(row, reference='run-'+_run_attempt(row)[:12], dimension=_dimension(row),
                run_observed_at=_ms_stamp(row['timestamp_ms']), settled=_settled(row),
                history_context=('baseline_unknown' if baseline_ms is None else 'start_unknown' if started is None else
                                 'started_before_baseline' if started < baseline_ms else 'started_since_baseline'),
                retained_history=True)


def _alert_evidence(alert):
    return {key: alert.get(key) for key in ('condition', 'reference', 'dimension', 'date', 'run_observed_at',
                                           'outcome', 'count', 'retry_at', 'error_category')}


def build_status(config: Config, adapter=None, *, now=None) -> dict:
    """Supported reads only. Does not create directories, lock, or send messages."""
    now = _clock(now)
    adapter = adapter or NativeAdapter(config.executable, timeout=config.timeout)
    local_error = None
    try:
        monitor = _load(config)
    except StateError:
        monitor = None
        local_error = 'monitor_state_unavailable'
    day = now.date().isoformat()
    standup = _standup(config, day)
    # Resolve/validate the bounded range before any native commands are executed.
    coverage = _coverage(config, monitor, now, standup)
    agents, jobs = adapter.agents(), adapter.jobs()
    runs = adapter.runs(page_size=config.page_size, max_pages=config.max_pages,
                        known_run_ids=tuple(monitor['anchors']) if monitor else ())
    counts = {}
    for alert in monitor['alerts'].values() if monitor else ():
        outcome = alert['outcome']
        counts[outcome] = counts.get(outcome, 0)+1
    runs_data = asdict(runs)
    runs_data['records'] = tuple(_run_evidence(row, monitor) for row in runs.records)
    return dict(version=1, observed_at=_stamp(now), date=day, timezone='Asia/Tomsk',
                sources=dict(agents=asdict(agents), jobs=asdict(jobs), runs=runs_data),
                standup=standup, coverage=coverage,
                monitor=dict(initialized=monitor is not None, error=local_error,
                             coverage_start=monitor['coverage_start'] if monitor else None,
                             baseline_at=monitor['baseline_at'] if monitor else None,
                             watermark_ms=monitor['watermark_ms'] if monitor else None,
                             last_check_at=monitor.get('last_check_at') if monitor else None,
                             last_check_error=monitor.get('last_check_error') if monitor else None,
                             alerts=counts,
                             alert_evidence=[_alert_evidence(a) for a in monitor['alerts'].values()] if monitor else [],
                             alert_error_categories=sorted({a['error_category'] for a in monitor['alerts'].values()
                                                            if a.get('error_category')}) if monitor else [],
                             retry_pending=sum(a['retry_safe'] and a['count'] < 3
                                               for a in monitor['alerts'].values()) if monitor else 0))


def _alias(row):
    started = row.get('started_at_ms')
    return f"cron:{row['job_id']}:{started}" if started is not None else None


def _running(jobs):
    return {f"cron:{row['id']}:{row['running_at_ms']}" for row in jobs
            if row.get('running_at_ms') is not None}


def _native_failed(row):
    return _dimension(row) != 'none'


def _conditions(config, report, state, now):
    conditions = []
    day = report['date']
    standup = report['standup']
    active = (day >= state['coverage_start'] and now.weekday() < 5 and day not in config.excluded_dates and
              (config.pause_until is None or day > config.pause_until))
    if active and standup['available']:
        if standup['input'] == 'missing' and now.time().replace(tzinfo=None) >= dt.time(7, 30):
            conditions.append(('missing_input', day))
        elif standup['input'] == 'stored':
            attempt = standup['attempt']
            if standup['processing'] == 'failed' or standup['delivery'] in ('failed', 'partial_failed', 'suppressed'):
                conditions.append(('standup_failed', attempt))
            elif standup['processing'] != 'succeeded' or standup['delivery'] != 'sent':
                deadline = dt.datetime.combine(now.date(), dt.time(7, 45), TOMSK)
                if standup['stored_at'] is not None:
                    deadline = max(deadline, _parse(standup['stored_at'])+dt.timedelta(minutes=15))
                if now >= deadline:
                    conditions.append(('standup_incomplete', attempt))
    runs = report['sources']['runs']
    # Even incomplete pages can prove a specific new failure. Unavailable source
    # records are not trusted for alerting; local coverage is assessed separately.
    if runs['available']:
        baseline_ms = int(_parse(state['baseline_at']).timestamp()*1000)
        for row in runs['records']:
            identity = row['identity']
            known_pending = identity in state['pending'] or _alias(row) in state['pending']
            new_start = row['started_at_ms'] is not None and row['started_at_ms'] >= baseline_ms
            if (identity not in state['seen'] and _alias(row) not in state['seen'] and
                    (known_pending or new_start) and _native_failed(row)):
                conditions.append(('native_failure', _run_attempt(row)))
    return conditions


def _owner(config):
    try:
        _protected(config.owner_file)
        with config.owner_file.open('rb') as stream:
            raw = stream.read(65)
        text = raw.decode('ascii').strip()
        if not re.fullmatch(r'[1-9][0-9]{0,19}', text):
            raise ValueError()
        return text
    except (OSError, ValueError):
        raise StateError('owner unavailable') from None


def check(config: Config, adapter=None, *, now=None, initialize=False) -> dict:
    """Serialize observation, pre-dispatch persistence and one bounded send pass."""
    now = _clock(now)
    adapter = adapter or NativeAdapter(config.executable, timeout=config.timeout)
    with _lock(config):
        state = _load(config)
        report = build_status(config, adapter, now=now)
        report['check'] = dict(initialized=False, dispatched=0, error=None)
        if initialize:
            if state is not None:
                report['check']['error'] = 'already_initialized'
                return report
            if not all(source['available'] and source['complete'] for source in report['sources'].values()):
                report['check']['error'] = 'baseline_unavailable'
                return report
            rows = report['sources']['runs']['records']
            state = dict(version=1, coverage_start=report['date'], baseline_at=_stamp(now),
                         watermark_ms=max((r['timestamp_ms'] for r in rows), default=0),
                         seen=sorted({key for r in rows if _settled(r)
                                      for key in (r['identity'], _alias(r)) if key is not None}),
                         pending=sorted(_running(report['sources']['jobs']['records']) |
                                         {key for r in rows if not _settled(r)
                                          for key in (r['identity'], _alias(r)) if key is not None}),
                         anchors=[r['identity'] for r in rows], alerts={})
            state.update(last_check_at=_stamp(now), last_check_error=None)
            _save(config, state)
            report['monitor'].update(initialized=True, coverage_start=state['coverage_start'],
                                     baseline_at=state['baseline_at'], watermark_ms=state['watermark_ms'],
                                     last_check_at=state['last_check_at'])
            report['check']['initialized'] = True
            report['coverage'] = _coverage(config, state, now, report['standup'])
            report['sources']['runs']['records'] = tuple(_run_evidence(row, state) for row in rows)
            return report
        if state is None:
            report['check']['error'] = 'not_initialized'
            return report
        conditions = _conditions(config, report, state, now)
        # Keep prior failed-native conditions eligible for proven pre-dispatch
        # retries even after their identity enters the observed terminal set.
        for key, alert in state['alerts'].items():
            if alert['condition'] == 'native_failure' and alert['retry_safe'] and alert['count'] < 3:
                conditions.append(('native_failure', alert['attempt']))
        for condition, attempt in dict.fromkeys(conditions):
            key = _hash(condition+':'+str(attempt))
            previous = state['alerts'].get(key)
            if previous and (not previous['retry_safe'] or previous['count'] >= 3 or
                             now < _parse(previous['retry_at'])):
                continue
            if previous is None and len(state['alerts']) >= MAX_ALERTS:
                report['check']['error'] = 'monitor_capacity'
                break
            if report['check']['dispatched'] >= MAX_DISPATCH_PER_CHECK:
                report['check']['error'] = 'dispatch_limit'
                break
            try:
                owner = _owner(config)
            except StateError:
                report['check']['error'] = 'owner_unavailable'
                break
            alert = dict(condition=condition, attempt=attempt, count=previous['count']+1 if previous else 1,
                         outcome='dispatching', retry_safe=False, retry_at=None, error_category=None)
            if previous and previous.get('reference'):
                alert.update({key: previous.get(key) for key in ('reference', 'dimension', 'date', 'run_observed_at')})
            elif condition == 'native_failure':
                row = next((r for r in report['sources']['runs']['records']
                            if _run_attempt(r) == attempt and _native_failed(r)), None)
                alert.update(reference='run-'+attempt[:12], dimension=_dimension(row) if row else 'unknown',
                             date=report['date'], run_observed_at=row['run_observed_at'] if row else None)
            else:
                dimension = ('input' if condition == 'missing_input' else
                             'processing' if report['standup']['processing'] == 'failed' else 'delivery')
                alert.update(reference='standup-'+_hash(str(attempt))[:12], dimension=dimension,
                             date=report['date'], run_observed_at=None)
            state['alerts'][key] = alert
            _save(config, state)  # crash thereafter is ambiguous and never blindly retried
            receipt = adapter.send_owner(owner, f'Pantheon {condition} ({alert["date"]}) '
                                        f'ref={alert["reference"]} dimension={alert["dimension"]}. '
                                        'Inspect pantheon-status for redacted stage/source evidence.')
            report['check']['dispatched'] += 1
            safe = bool(receipt.retry_safe and receipt.error and receipt.error.pre_dispatch and
                        receipt.error.category in ('spawn_failed', 'executable_unavailable'))
            alert.update(outcome=receipt.outcome, retry_safe=safe,
                         retry_at=_stamp(now+dt.timedelta(seconds=60*2**(alert['count']-1))) if safe else None,
                         error_category=receipt.error.category if receipt.error else None)
            _save(config, state)
        runs, jobs = report['sources']['runs'], report['sources']['jobs']
        if (not report['check']['error'] and runs['available'] and runs['complete'] and
                jobs['available'] and jobs['complete']):
            seen, pending = set(state['seen']), set(state['pending'])
            for row in runs['records']:
                if _settled(row):
                    seen.add(row['identity'])
                    if _alias(row) is not None:
                        seen.add(_alias(row))
                    pending.discard(row['identity']); pending.discard(_alias(row))
                else:
                    pending.add(row['identity'])
                    if _alias(row) is not None:
                        pending.add(_alias(row))
            pending |= _running(jobs['records'])
            state.update(seen=sorted(seen), pending=sorted(pending),
                         anchors=[r['identity'] for r in runs['records']],
                         watermark_ms=max(state['watermark_ms'], max((r['timestamp_ms'] for r in runs['records']), default=0)))
        state.update(last_check_at=_stamp(now), last_check_error=report['check']['error'])
        _save(config, state)
        counts = {}
        for alert in state['alerts'].values():
            counts[alert['outcome']] = counts.get(alert['outcome'], 0)+1
        report['monitor'].update(alerts=counts, watermark_ms=state['watermark_ms'],
                                 alert_evidence=[_alert_evidence(a) for a in state['alerts'].values()],
                                 last_check_at=state['last_check_at'], last_check_error=state['last_check_error'],
                                 alert_error_categories=sorted({a['error_category'] for a in state['alerts'].values()
                                                                if a.get('error_category')}),
                                 retry_pending=sum(a['retry_safe'] and a['count'] < 3 for a in state['alerts'].values()))
        return report


def render_text(report):
    lines = [f"Pantheon {report['date']} ({report['timezone']}) observed {report['observed_at']}"]
    for name, source in report['sources'].items():
        lines.append(f"{name}: {'available' if source['available'] else 'UNAVAILABLE'}; "
                     f"observed {source['observed_at']}; complete={source['complete']}; gaps={','.join(source['gaps']) or 'none'}")
        if source['error']:
            lines.append('  error: '+source['error']['category'])
    lines.append('Configured agents: '+', '.join(r['id'] for r in report['sources']['agents']['records']))
    for row in report['sources']['runs']['records']:
        lines.append(f"Run {row['identity']} ref={row['reference']} at={row['run_observed_at'] or 'unknown'} "
                     f"retained_history baseline={report['monitor']['baseline_at'] or 'unknown'} "
                     f"context={row['history_context']} dimension={row['dimension']}: "
                     f"processing={row['processing']} delivery={row['delivery']} completion={row['completion']}")
    standup = report['standup']
    lines.append(f"Standup ref={standup['reference']}: {standup['storage']}; processing={standup['processing']} delivery={standup['delivery']}")
    coverage = report['coverage']
    lines.append(f"Coverage {coverage['since']}..{coverage['until']} current_policy_assumption_not_maintenance_history "
                 f"counts={json.dumps(coverage['counts'], sort_keys=True)} gaps={','.join(coverage['gaps']) or 'none'}")
    for row in coverage['days']:
        lines.append(f"  {row['date']} ref={row['reference']} {row['monitoring']} expected={row['expected']} due={row['due']} "
                     f"received={row['received']} storage={row['storage']} processing={row['processing']} delivery={row['delivery']}")
    lines.append('Monitor: '+json.dumps(report['monitor'], sort_keys=True))
    if 'check' in report:
        lines.append('Check: '+json.dumps(report['check'], sort_keys=True))
    lines.append('sent = platform-send acknowledgement, never recipient display/read')
    return '\n'.join(lines)


def main(kind='status', argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--state-dir', type=Path, default=Path(os.environ.get('PANTHEON_STATE_DIR', str(Config.state_dir))))
    parser.add_argument('--workspace', type=Path, default=Path(os.environ.get('PANTHEON_WORKSPACE', str(Config.workspace))))
    parser.add_argument('--owner-chat-file', type=Path, default=Path(os.environ.get('PANTHEON_OWNER_CHAT_FILE', str(Config.owner_file))))
    parser.add_argument('--native-executable', default=os.environ.get('PANTHEON_NATIVE_EXECUTABLE', 'openclaw'))
    parser.add_argument('--timeout', type=float, default=10.0)
    parser.add_argument('--page-size', type=int, default=50)
    parser.add_argument('--max-pages', type=int, default=5)
    parser.add_argument('--exclude-date', action='append', default=[])
    parser.add_argument('--pause-until')
    parser.add_argument('--since')
    parser.add_argument('--until')
    if kind == 'check':
        parser.add_argument('--initialize', action='store_true')
    args = parser.parse_args(argv)
    try:
        config = Config(state_dir=args.state_dir, workspace=args.workspace, owner_file=args.owner_chat_file,
                        executable=args.native_executable, timeout=args.timeout, page_size=args.page_size,
                        max_pages=args.max_pages, excluded_dates=tuple(args.exclude_date), pause_until=args.pause_until,
                        since=args.since, until=args.until)
        report = check(config, initialize=args.initialize) if kind == 'check' else build_status(config)
        print(json.dumps(report, sort_keys=True) if args.json else render_text(report))
        unhealthy = (report['monitor']['error'] or report['monitor']['last_check_error'] or not report['standup']['available'] or
                     report['coverage']['unavailable_dates'] or 'range_truncated' in report['coverage']['gaps'] or
                     any(not s['available'] or not s['complete'] for s in report['sources'].values()) or
                     report.get('check', {}).get('error') or
                     any(report['monitor']['alerts'].get(k, 0) for k in ('dispatching', 'unknown', 'queued', 'failed', 'partial_failed', 'suppressed')))
        return 2 if unhealthy else 0
    except (ValueError, OSError):
        print(json.dumps({'error': 'monitor_configuration_or_state_unavailable'}) if args.json else
              'pantheon: monitor configuration or state unavailable')
        return 2
