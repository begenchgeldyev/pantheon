"""Clock-controlled monitoring tests. No native runtime is used."""
import dataclasses
import datetime as dt
import json
import hashlib
import multiprocessing
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess
import sys

from native import NativeError, ReadResult, SendResult, normalize_run
from monitor import Config, build_status, check, render_text
from state import initial, save


def clock(text='2026-11-12T07:29:00+07:00'):
    return dt.datetime.fromisoformat(text)


class Fake:
    def __init__(self):
        self.rows = ()
        self.job_rows = ()
        self.available = True
        self.complete = True
        self.sent = []
        self.receipt = SendResult('sent', 'provider_message_id')
    def agents(self):
        return ReadResult('native_agents', '2026-11-12T00:00:00Z', self.available,
                          ({'id': 'main', 'is_default': True},), self.available)
    def jobs(self):
        return ReadResult('native_cron_list', '2026-11-12T00:00:00Z', self.available,
                          self.job_rows, self.available)
    def runs(self, **kwargs):
        return ReadResult('native_cron_runs', '2026-11-12T00:00:00Z', self.available,
                          self.rows, self.complete,
                          () if self.complete else ('page_limit',),
                          None if self.available else NativeError('timeout'))
    def send_owner(self, target, message):
        self.sent.append((target, message))
        return self.receipt


class ProcessFake(Fake):
    def __init__(self, path):
        super().__init__()
        self.path = path
    def send_owner(self, target, message):
        with self.path.open('a') as stream:
            stream.write('send\n')
        return self.receipt


def concurrent_tick(config, log):
    check(config, ProcessFake(log), now=clock('2026-11-12T07:30:00+07:00'))


def cron(rid, start, status='error', **kwargs):
    raw = dict(jobId='job', runId=rid, ts=start+100, runAtMs=start,
               status=status, deliveryStatus='not-requested')
    return normalize_run(raw | kwargs)


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.owner = base / 'owner'
        self.owner.write_text('123456789\n'); self.owner.chmod(0o600)
        self.config = Config(state_dir=base/'state', workspace=base/'workspace', owner_file=self.owner)
        self.fake = Fake()
    def init(self, now=None):
        return check(self.config, self.fake, now=now or clock(), initialize=True)
    def tick(self, stamp):
        return check(self.config, self.fake, now=clock(stamp))
    def stored(self, stamp='2026-11-12T00:00:00Z', processing='accepted', delivery='unknown'):
        value = initial('2026-11-12', b'PRIVATE SUMMARY', stamp)
        value['processing']['status'] = processing
        value['delivery']['status'] = delivery
        save(self.config.state_dir, '2026-11-12', value)
        return value
    def monitor_state(self):
        return json.loads((self.config.state_dir/'monitor/state.json').read_text())

    def test_status_read_only_uninitialized_and_redacted(self):
        report = build_status(self.config, self.fake, now=clock())
        self.assertFalse(self.config.state_dir.exists())
        self.assertFalse(report['monitor']['initialized'])
        self.assertEqual(self.fake.sent, [])
        self.assertNotIn('123456789', json.dumps(report))

    def test_no_implicit_baseline_and_unavailable_init_does_not_reset(self):
        self.assertEqual(self.tick('2026-11-12T08:00:00+07:00')['check']['error'], 'not_initialized')
        self.fake.available = False
        self.assertEqual(self.init()['check']['error'], 'baseline_unavailable')
        self.assertFalse((self.config.state_dir/'monitor/state.json').exists())
        self.fake.available = True; self.init()
        previous = self.monitor_state()
        self.fake.available = False
        self.assertEqual(self.init()['check']['error'], 'already_initialized')
        self.assertEqual(previous, self.monitor_state())
        self.assertFalse(self.fake.sent)

    def test_baseline_no_backlog_running_transition_and_new_failure(self):
        start = int(clock().timestamp()*1000)
        self.fake.rows = (cron('old', start-10000),)
        self.fake.job_rows = ({'id': 'job', 'running_at_ms': start-5000},)
        self.init()
        self.assertFalse(self.fake.sent)
        self.fake.rows += (cron('inflight-terminal', start-5000), cron('new', start+1000))
        self.tick('2026-11-12T07:29:10+07:00')
        self.assertEqual(len(self.fake.sent), 2)
        self.tick('2026-11-12T07:29:20+07:00')
        self.assertEqual(len(self.fake.sent), 2)

    def test_gaps_do_not_advance_watermark_but_proven_failure_alerts(self):
        self.init()
        old_watermark = self.monitor_state()['watermark_ms']
        self.fake.complete = False
        self.fake.rows = (cron('new', int(clock().timestamp()*1000)+1000),)
        report = self.tick('2026-11-12T07:29:10+07:00')
        self.assertEqual(self.monitor_state()['watermark_ms'], old_watermark)
        self.assertEqual(len(self.fake.sent), 1)
        self.assertFalse(report['sources']['runs']['complete'])

    def test_missing_deadline_and_no_recovery_spam(self):
        self.init()
        self.tick('2026-11-12T07:29:59+07:00'); self.assertFalse(self.fake.sent)
        self.tick('2026-11-12T07:30:00+07:00'); self.assertEqual(len(self.fake.sent), 1)
        self.tick('2026-11-12T07:45:00+07:00'); self.assertEqual(len(self.fake.sent), 1)
        self.stored(processing='succeeded', delivery='sent')
        self.tick('2026-11-12T08:00:00+07:00'); self.assertEqual(len(self.fake.sent), 1)

    def test_incomplete_deadline_late_arrival_and_attempt_dedupe(self):
        self.init(); self.stored('2026-11-12T00:40:00Z')
        self.tick('2026-11-12T07:45:00+07:00'); self.assertFalse(self.fake.sent)
        self.tick('2026-11-12T07:54:59+07:00'); self.assertFalse(self.fake.sent)
        self.tick('2026-11-12T07:55:00+07:00'); self.assertEqual(len(self.fake.sent), 1)
        self.tick('2026-11-12T08:00:00+07:00'); self.assertEqual(len(self.fake.sent), 1)

    def test_explicit_standup_failure_partial_suppressed_once_per_attempt(self):
        self.init()
        for delivery in ('failed', 'partial_failed', 'suppressed'):
            self.stored(delivery=delivery)
            self.tick('2026-11-12T07:29:00+07:00')
            self.tick('2026-11-12T08:00:00+07:00')
        self.assertEqual(len(self.fake.sent), 3)

    def test_weekends_pause_excluded_and_local_rollover(self):
        self.init()
        for stamp in ('2026-11-14T08:00:00+07:00', '2026-11-15T08:00:00+07:00'):
            self.tick(stamp)
        excluded = dataclasses.replace(self.config, excluded_dates=('2026-11-12',))
        check(excluded, self.fake, now=clock('2026-11-12T08:00:00+07:00'))
        paused = dataclasses.replace(self.config, pause_until='2026-11-13')
        check(paused, self.fake, now=clock('2026-11-13T08:00:00+07:00'))
        self.assertFalse(self.fake.sent)
        report = build_status(self.config, self.fake, now=clock('2026-11-12T18:00:00+00:00'))
        self.assertEqual(report['date'], '2026-11-13')

    def test_legacy_stat_only_unknown_and_malformed_state_not_missing(self):
        self.init()
        path = self.config.workspace/'standups/2026-11-12.md'
        path.parent.mkdir(parents=True); path.write_text('PRIVATE SUMMARY')
        os.utime(path, (clock().timestamp()-3600,)*2)
        report = self.tick('2026-11-12T07:45:00+07:00')
        self.assertEqual(report['standup']['storage'], 'legacy_stored_only')
        self.assertNotIn('PRIVATE', json.dumps(report))
        self.assertEqual(len(self.fake.sent), 1)
        self.assertIn('standup_incomplete', self.fake.sent[0][1])
        bad = self.config.state_dir/'standups/2026-11-12/state.json'
        bad.parent.mkdir(parents=True); bad.write_text('{bad PRIVATE')
        report = self.tick('2026-11-12T08:00:00+07:00')
        self.assertFalse(report['standup']['available'])
        self.assertEqual(len(self.fake.sent), 1)

    def test_queued_unknown_failed_partial_never_blind_retry(self):
        for outcome in ('queued', 'unknown', 'failed', 'partial_failed'):
            with self.subTest(outcome=outcome):
                self.fake.receipt = SendResult(outcome)
                self.stored(delivery='failed')
                if not (self.config.state_dir/'monitor/state.json').exists(): self.init()
                self.tick('2026-11-12T07:29:00+07:00')
                before = len(self.fake.sent)
                self.tick('2026-11-12T08:00:00+07:00')
                self.assertEqual(len(self.fake.sent), before)

    def test_pre_dispatch_persistence_crash_and_protected_files(self):
        self.init(); self.stored(delivery='failed')
        def crash(target, message):
            self.assertEqual(next(iter(self.monitor_state()['alerts'].values()))['outcome'], 'dispatching')
            raise RuntimeError('PRIVATE')
        self.fake.send_owner = crash
        with self.assertRaises(RuntimeError): self.tick('2026-11-12T07:29:00+07:00')
        self.fake.send_owner = lambda *args: self.fail('must not redispatch')
        self.tick('2026-11-12T08:00:00+07:00')
        directory = self.config.state_dir/'monitor'
        self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual((directory/'state.json').stat().st_mode & 0o777, 0o600)

    def test_only_proven_spawn_failure_retries_bounded_with_backoff(self):
        self.init(); self.stored(delivery='failed')
        self.fake.receipt = SendResult('unknown', retry_safe=True, error=NativeError('spawn_failed', True))
        for stamp, count in [('07:29:00', 1), ('07:29:30', 1), ('07:30:00', 2),
                             ('07:31:00', 2), ('07:32:00', 3), ('08:00:00', 3)]:
            self.tick('2026-11-12T'+stamp+'+07:00')
            self.assertEqual(len(self.fake.sent), count)

    def test_unavailable_native_still_assesses_local_coverage(self):
        self.init(); self.fake.available = False
        report = self.tick('2026-11-12T07:30:00+07:00')
        self.assertFalse(report['sources']['runs']['available'])
        self.assertEqual(len(self.fake.sent), 1)

    def test_invalid_config_and_owner_never_leak_or_send(self):
        for kwargs in ({'page_size': 0}, {'max_pages': 101}, {'excluded_dates': ('bad',)},
                       {'pause_until': '2026-02-30'}):
            with self.assertRaises(ValueError): dataclasses.replace(self.config, **kwargs)
        self.init(); self.stored(delivery='failed')
        self.owner.write_text('PRIVATE-INVALID')
        report = self.tick('2026-11-12T07:29:00+07:00')
        self.assertFalse(self.fake.sent)
        self.assertNotIn('PRIVATE', json.dumps(report))
        self.assertEqual(report['check']['error'], 'owner_unavailable')

    def test_concurrent_checkers_dispatch_once(self):
        self.init()
        log = Path(self.tmp.name)/'sends'
        ctx = multiprocessing.get_context('fork')
        processes = [ctx.Process(target=concurrent_tick, args=(self.config, log)) for _ in range(3)]
        for process in processes: process.start()
        for process in processes:
            process.join(5)
            self.assertEqual(process.exitcode, 0)
        self.assertEqual(log.read_text(), 'send\n')

    def test_baseline_history_pending_completes_and_informational_cron(self):
        start = int(clock().timestamp()*1000)-10000
        self.fake.rows = (cron('pending', start, status='in_flight'),)
        self.init()
        self.fake.rows = (cron('pending', start),
                          cron('skip', start+20000, status='skipped', error='empty-heartbeat-file'),
                          cron('suppressed', start+20001, status='ok', completionStatus='succeeded',
                               deliveryStatus='not-delivered', deliverySuppressionReason='no_visible_payload'))
        self.tick('2026-11-12T07:29:20+07:00')
        self.assertEqual(len(self.fake.sent), 1)

    def test_corrupt_monitor_state_and_symlink_refuse_dispatch(self):
        self.init()
        path = self.config.state_dir/'monitor/state.json'
        path.write_text('{PRIVATE corrupt')
        report = build_status(self.config, self.fake, now=clock())
        self.assertEqual(report['monitor']['error'], 'monitor_state_unavailable')
        with self.assertRaises(ValueError): self.tick('2026-11-12T07:30:00+07:00')
        path.unlink(); path.symlink_to(self.owner)
        with self.assertRaises(ValueError): self.tick('2026-11-12T07:30:00+07:00')
        self.assertFalse(self.fake.sent)

    def test_owner_failure_does_not_lose_new_native_failure(self):
        self.init()
        self.fake.rows = (cron('new', int(clock().timestamp()*1000)+1000),)
        self.owner.write_text('bad')
        self.tick('2026-11-12T07:29:10+07:00')
        self.owner.write_text('123456789\n')
        self.tick('2026-11-12T07:29:20+07:00')
        self.assertEqual(len(self.fake.sent), 1)

    def test_run_alias_does_not_duplicate_failure_or_realert_baseline(self):
        start = int(clock().timestamp()*1000)-1000
        old = dict(cron('old', start), identity=f'cron:job:{start}', run_id=None)
        self.fake.rows = (old,)
        self.init()
        self.fake.rows = (cron('old-public-id', start),)
        self.tick('2026-11-12T07:29:10+07:00')
        self.assertFalse(self.fake.sent)
        start += 2000
        self.fake.rows += (dict(cron('new', start), identity=f'cron:job:{start}', run_id=None),)
        self.tick('2026-11-12T07:29:20+07:00')
        self.assertEqual(len(self.fake.sent), 1)

        self.fake.rows = (cron('new-public-id', start),)
        self.tick('2026-11-12T07:29:30+07:00')
        self.assertEqual(len(self.fake.sent), 1)

    def test_delayed_delivery_failure_after_processing_success(self):
        self.init()
        start = int(clock().timestamp()*1000)+1000
        self.fake.rows = (cron('delayed', start, status='ok', completionStatus='unknown', deliveryStatus='unknown'),)
        self.tick('2026-11-12T07:29:10+07:00')
        self.assertNotIn('delayed', self.monitor_state()['seen'])
        self.assertIn('delayed', self.monitor_state()['pending'])
        self.fake.rows = (cron('delayed', start, status='ok', completionStatus='failed', deliveryStatus='not-delivered'),)
        self.fake.receipt = SendResult('unknown', retry_safe=True, error=NativeError('spawn_failed', True))
        report = self.tick('2026-11-12T07:29:20+07:00')
        self.assertEqual(len(self.fake.sent), 1)
        evidence = report['monitor']['alert_evidence'][0]
        self.assertEqual(evidence['dimension'], 'delivery')
        self.assertIn(evidence['reference'], self.fake.sent[0][1])
        self.tick('2026-11-12T07:29:30+07:00'); self.assertEqual(len(self.fake.sent), 1)
        self.fake.rows = ()  # retry retains the same reference/dimension after settlement
        self.fake.receipt = SendResult('sent', 'provider_message_id')
        self.tick('2026-11-12T07:30:20+07:00')
        self.assertEqual(len(self.fake.sent), 3)  # native retry + today's missing input
        self.assertEqual(sum(message == self.fake.sent[0][1] for _, message in self.fake.sent), 2)

    def test_baseline_unresolved_delivery_failure_is_not_historical_backlog(self):
        start = int(clock().timestamp()*1000)-10000
        self.fake.rows = (cron('pending-delivery', start, status='ok', completionStatus='unknown', deliveryStatus='unknown'),
                          cron('historical-failure', start-1000))
        self.init()
        self.assertNotIn('pending-delivery', self.monitor_state()['seen'])
        self.fake.rows = (cron('pending-delivery', start, status='ok', completionStatus='failed', deliveryStatus='not-delivered'),
                          cron('historical-failure', start-1000))
        self.tick('2026-11-12T07:29:20+07:00'); self.assertEqual(len(self.fake.sent), 1)
        self.tick('2026-11-12T07:29:30+07:00'); self.assertEqual(len(self.fake.sent), 1)

    def test_failure_dimension_terminal_without_processing_terminal(self):
        self.init()
        start = int(clock().timestamp()*1000)+1000
        self.fake.rows = (cron('delivery-failure', start, status='new-status', completionStatus='unknown', deliveryStatus='not-delivered'),)
        self.tick('2026-11-12T07:29:10+07:00')
        self.assertEqual(len(self.fake.sent), 1)

    def test_coverage_range_weekdays_legacy_malformed_and_before_baseline(self):
        self.init()
        config = dataclasses.replace(self.config, since='2026-11-09', until='2026-11-16')
        legacy = config.workspace/'standups/2026-11-13.md'
        legacy.parent.mkdir(parents=True); legacy.write_text('PRIVATE')
        bad = config.state_dir/'standups/2026-11-12/state.json'
        bad.parent.mkdir(parents=True); bad.write_text('{PRIVATE')
        report = build_status(config, self.fake, now=clock('2026-11-16T07:29:00+07:00'))
        coverage = report['coverage']; days = {row['date']: row for row in coverage['days']}
        self.assertEqual(days['2026-11-09']['monitoring'], 'not_monitored')
        self.assertIsNone(days['2026-11-09']['expected'])
        self.assertFalse(days['2026-11-14']['expected'])
        self.assertEqual(days['2026-11-13']['storage'], 'legacy_stored_only')
        self.assertEqual(days['2026-11-12']['received'], 'unknown')
        self.assertFalse(days['2026-11-16']['due'])
        self.assertEqual(coverage['counts']['received'], 1)
        self.assertEqual(coverage['counts']['source_unavailable'], 1)
        self.assertEqual(coverage['missing_dates'], [])
        self.assertNotIn('PRIVATE', json.dumps(report))
        self.assertFalse(self.fake.sent)
        self.assertEqual(coverage['policy']['basis'], 'current_policy_assumption_not_maintenance_history')

    def test_coverage_missing_sent_future_bounds_truncation_and_read_only(self):
        self.init(); self.stored(processing='succeeded', delivery='sent')
        config = dataclasses.replace(self.config, since='2026-11-12', until='2026-11-17',
                                     excluded_dates=('2026-11-13',))
        before = {p: p.read_bytes() for p in self.config.state_dir.rglob('*') if p.is_file()}
        report = build_status(config, self.fake, now=clock('2026-11-16T07:30:00+07:00'))
        days = {row['date']: row for row in report['coverage']['days']}
        self.assertEqual(report['coverage']['missing_dates'], ['2026-11-16'])
        self.assertEqual(days['2026-11-12']['delivery'], 'sent')
        self.assertFalse(days['2026-11-17']['due'])
        self.assertEqual(before, {p: p.read_bytes() for p in self.config.state_dir.rglob('*') if p.is_file()})
        for kwargs in ({'since': 'bad'}, {'until': '2026-02-30'},
                       {'since': '2026-11-13', 'until': '2026-11-12'},
                       {'since': '2025-01-01', 'until': '2026-11-12'}):
            with self.assertRaises(ValueError): dataclasses.replace(self.config, **kwargs)
        report = build_status(self.config, self.fake, now=clock('2028-11-12T08:00:00+07:00'))
        self.assertEqual(len(report['coverage']['days']), 366)
        self.assertIn('range_truncated', report['coverage']['gaps'])
        self.assertFalse(self.fake.sent)

    def test_legacy_coverage_never_opens_summary_and_pauses_are_current_policy(self):
        self.init()
        legacy = self.config.workspace/'standups/2026-11-12.md'
        legacy.parent.mkdir(parents=True); legacy.write_text('PRIVATE')
        config = dataclasses.replace(self.config, since='2026-11-12', until='2026-11-13',
                                     pause_until='2026-11-13')
        original = Path.open
        def guarded(path, *args, **kwargs):
            if path == legacy:
                self.fail('legacy content must never be opened')
            return original(path, *args, **kwargs)
        with patch.object(Path, 'open', guarded):
            report = build_status(config, self.fake, now=clock('2026-11-13T08:00:00+07:00'))
        self.assertEqual(report['coverage']['counts']['received'], 1)
        self.assertEqual(report['coverage']['counts']['due'], 0)
        self.assertEqual(report['coverage']['missing_dates'], [])
        self.assertEqual(report['coverage']['policy']['pause_until'], '2026-11-13')

    def test_uninitialized_explicit_history_unknown_and_today_only_alerts(self):
        config = dataclasses.replace(self.config, since='2026-11-09', until='2026-11-13')
        report = build_status(config, self.fake, now=clock())
        self.assertFalse(self.config.state_dir.exists())
        self.assertTrue(all(row['expected'] is None for row in report['coverage']['days']))
        self.init()
        config = dataclasses.replace(self.config, since='2026-11-12', until='2026-11-13')
        check(config, self.fake, now=clock('2026-11-13T08:00:00+07:00'))
        self.assertEqual(len(self.fake.sent), 1)
        self.assertIn('2026-11-13', self.fake.sent[0][1])

    def test_correlated_dated_retained_run_and_alert_evidence(self):
        start = int(clock().timestamp()*1000)-1000
        self.fake.rows = (cron('old', start),); self.init()
        self.fake.rows += (cron('new', start+2000),)
        report = self.tick('2026-11-12T07:29:10+07:00')
        text = render_text(report)
        self.assertIn('retained_history', text)
        self.assertIn('baseline=', text)
        rows = report['sources']['runs']['records']
        ref = rows[-1]['reference']
        self.assertIn(ref, self.fake.sent[0][1])
        self.assertIn('dimension=processing', self.fake.sent[0][1])
        self.assertIn(ref, text)
        self.assertIn(rows[-1]['run_observed_at'], text)
        self.assertEqual(report['monitor']['alert_evidence'][0]['reference'], ref)

    def test_alert_batch_is_bounded_without_losing_remaining_failures(self):
        self.init()
        start = int(clock().timestamp()*1000)+1000
        self.fake.rows = tuple(cron('new'+str(i), start+i) for i in range(7))
        report = self.tick('2026-11-12T07:29:10+07:00')
        self.assertEqual(len(self.fake.sent), 5)
        self.assertEqual(report['check']['error'], 'dispatch_limit')
        self.tick('2026-11-12T07:29:20+07:00')
        self.assertEqual(len(self.fake.sent), 7)

    def test_cli_fake_executable_smoke_status_is_read_only(self):
        base = Path(__file__).resolve().parents[1]
        scenario, log = Path(self.tmp.name)/'scenario.json', Path(self.tmp.name)/'argv.jsonl'
        scenario.write_text(json.dumps({
            'agents list --json': {'json': [{'id': 'main', 'isDefault': True}]},
            'cron list --all --json': {'json': {'jobs': []}},
            'cron runs --all --limit 50 --offset 0 --sort desc': {'json': {
                'entries': [], 'total': 0, 'offset': 0, 'limit': 50, 'hasMore': False, 'nextOffset': None}}}))
        env = dict(os.environ, PANTHEON_FAKE_SCENARIO=str(scenario), PANTHEON_FAKE_LOG=str(log),
                   PYTHONDONTWRITEBYTECODE='1', TMPDIR='/tmp/opencode')
        common = ['--state-dir', str(self.config.state_dir), '--workspace', str(self.config.workspace),
                  '--owner-chat-file', str(self.owner),
                  '--native-executable', str(base/'fixtures/monitor/fake_native.py')]
        def invoke(name, flags):
            return subprocess.run([sys.executable, str(base/name), *common, *flags],
                                  env=env, capture_output=True, text=True, timeout=5)
        result = invoke('pantheon-status', ['--json'])
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertFalse(self.config.state_dir.exists())
        self.assertFalse(json.loads(result.stdout)['monitor']['initialized'])
        day = dt.date.fromisoformat(json.loads(result.stdout)['date'])
        since, until = (day-dt.timedelta(days=2)).isoformat(), (day+dt.timedelta(days=1)).isoformat()
        result = invoke('pantheon-status', ['--json', '--since', since, '--until', until])
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        coverage = json.loads(result.stdout)['coverage']
        self.assertEqual(len(coverage['days']), 4)
        self.assertTrue(all(row['expected'] is None for row in coverage['days']))
        self.assertFalse(self.config.state_dir.exists())
        result = invoke('pantheon-check', ['--initialize', '--json'])
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        initialized = json.loads(result.stdout)
        self.assertTrue(initialized['check']['initialized'])
        result = invoke('pantheon-status', [])
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertIn('platform-send acknowledgement', result.stdout)
        self.assertNotIn('message', log.read_text())
        before = log.read_bytes()
        result = invoke('pantheon-status', ['--json', '--page-size', '201'])
        self.assertEqual(result.returncode, 2)
        self.assertEqual(log.read_bytes(), before)
        scenario_data = json.loads(scenario.read_text())
        started = int(dt.datetime.fromisoformat(initialized['monitor']['baseline_at']).timestamp()*1000)+1
        scenario_data['cron runs --all --limit 50 --offset 0 --sort desc']['json'].update(
            entries=[dict(jobId='job', runId='new', ts=started+1, runAtMs=started,
                          status='error', deliveryStatus='not-requested')], total=1)
        reference = 'run-'+hashlib.sha256(f'cron:job:{started}'.encode()).hexdigest()[:12]
        text = (f'Pantheon native_failure ({initialized["date"]}) ref={reference} dimension=processing. '
                'Inspect pantheon-status for redacted stage/source evidence.')
        scenario_data[f'message send --channel telegram --target 123456789 --message {text} --json'] = {
            'json': dict(action='send', channel='telegram', dryRun=False, handledBy='plugin',
                         messageId='42', payload={'messageId': '42', 'chatId': '123456789'})}
        # Avoid a real-calendar missing-input alert: a conclusively sent receipt
        # satisfies today's local coverage independently of the new cron failure.
        value = initial(initialized['date'], b'PRIVATE SUMMARY')
        value['processing']['status'] = 'succeeded'; value['delivery']['status'] = 'sent'
        save(self.config.state_dir, initialized['date'], value)
        scenario.write_text(json.dumps(scenario_data))
        result = invoke('pantheon-check', ['--json'])
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertEqual(json.loads(result.stdout)['check']['dispatched'], 1)
        self.assertEqual(json.loads(result.stdout)['monitor']['alert_evidence'][0]['reference'], reference)
        self.assertEqual(json.loads(result.stdout)['sources']['runs']['records'][0]['reference'], reference)
        self.assertNotIn('123456789', result.stdout)
        self.assertNotIn('123456789', (self.config.state_dir/'monitor/state.json').read_text())
        result = invoke('pantheon-check', ['--json'])
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertEqual(json.loads(result.stdout)['check']['dispatched'], 0)
        self.assertEqual(sum(json.loads(line)[:2] == ['message', 'send'] for line in log.read_text().splitlines()), 1)


if __name__ == '__main__':
    unittest.main()
