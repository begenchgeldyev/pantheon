"""Native adapter tests: all child processes are explicitly fake executables."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from native import NativeAdapter, NativeError, normalize_run, parse_send_result


FIXTURE = Path(__file__).resolve().parents[1] / 'fixtures/monitor/fake_native.py'


def page(entries, offset=0, total=None, more=False):
    return dict(entries=entries, offset=offset, limit=2,
                total=len(entries) if total is None else total,
                hasMore=more, nextOffset=offset + len(entries) if more else None)


def run(rid='r1', **extra):
    return dict(jobId='job1', runId=rid, ts=1200, runAtMs=1000,
                status='ok', deliveryStatus='not-delivered', **extra)


class NativeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.scenario = Path(self.tmp.name) / 'scenario.json'
        self.log = Path(self.tmp.name) / 'argv.jsonl'
        self.env = patch.dict(os.environ, PANTHEON_FAKE_SCENARIO=str(self.scenario),
                              PANTHEON_FAKE_LOG=str(self.log))
        self.env.start()
        self.addCleanup(self.env.stop)

    def adapter(self, scenario, **kwargs):
        self.scenario.write_text(json.dumps(scenario))
        return NativeAdapter((sys.executable, str(FIXTURE)), **kwargs)

    def argv(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_roster_and_list_redaction_and_empty(self):
        adapter = self.adapter({
            'agents list --json': {'json': [{'id': 'main', 'isDefault': True,
                                            'workspace': 'SECRET', 'identityName': 'PRIVATE'}]},
            'cron list --all --json': {'json': {'jobs': []}}})
        result = adapter.agents()
        self.assertTrue(result.available)
        self.assertEqual(result.records, ({'id': 'main', 'is_default': True},))
        self.assertNotIn('SECRET', repr(result))
        self.assertTrue(adapter.jobs().available)
        self.assertEqual(self.argv(), [['agents', 'list', '--json'],
                                      ['cron', 'list', '--all', '--json']])

    def test_unavailable_not_empty_and_safe_errors(self):
        for reply, category in [({'stdout': 'SECRET'}, 'malformed_json'),
                                ({'json': {'jobs': [None]}}, 'schema_drift'),
                                ({'exit': 1, 'stderr': 'SECRET token'}, 'command_failed'),
                                ({'json': {'ok': False, 'error': 'SECRET'}}, 'command_failed')]:
            with self.subTest(category=category):
                result = self.adapter({'*': reply}).jobs()
                self.assertFalse(result.available)
                self.assertEqual(result.error.category, category)
                self.assertNotIn('SECRET', repr(result))

    def test_timeout_output_limit_missing_executable(self):
        for reply, options, category in [({'sleep': .5}, {'timeout': .05}, 'timeout'),
                                        ({'stdout': 'x' * 5000}, {'max_output_bytes': 1000}, 'output_limit')]:
            result = self.adapter({'*': reply}, **options).jobs()
            self.assertEqual(result.error.category, category)
        result = NativeAdapter(('/nonexistent/pantheon-fixture',)).jobs()
        self.assertEqual(result.error.category, 'executable_unavailable')
        self.assertTrue(result.error.pre_dispatch)

    def test_paginated_overlap_and_retention_gap(self):
        adapter = self.adapter({
            'cron runs --all --limit 2 --offset 0 --sort desc':
                {'json': page([run('r3'), run('r2')], total=3, more=True)},
            'cron runs --all --limit 2 --offset 2 --sort desc':
                {'json': page([run('r2'), run('r1')], offset=2, total=4)}})
        result = adapter.runs(page_size=2, max_pages=3, known_run_ids=('r0',))
        self.assertEqual(len(result.records), 3)
        self.assertIn('pagination_changed', result.gaps)
        self.assertIn('history_anchor_missing', result.gaps)
        self.assertEqual(result.records[0]['run_id'], 'r3')
        self.assertIsNotNone(result.observed_at)

    def test_page_limit_partial_source_and_schema(self):
        adapter = self.adapter({'*': {'json': page([run()], total=3, more=True)}})
        result = adapter.runs(page_size=2, max_pages=1)
        self.assertIn('page_limit', result.gaps)
        self.assertFalse(result.complete)
        for body in ({'entries': []}, page([None]), page([{'jobId': 'job'}])):
            result = self.adapter({'*': {'json': body}}).runs()
            self.assertFalse(result.available)
            self.assertEqual(result.error.category, 'schema_drift')

    def test_independent_processing_delivery_and_identity(self):
        raw = run(summary='SECRET', error='SECRET', deliveryError='SECRET')
        result = normalize_run(raw)
        self.assertEqual(result['processing'], 'failed')
        self.assertEqual(result['delivery'], 'failed')
        self.assertNotIn('SECRET', repr(result))
        for status, processing in [('ok', 'succeeded'), ('error', 'failed'),
                                   ('skipped', 'skipped'), ('in_flight', 'pending'),
                                   ('new-status', 'unknown')]:
            raw = dict(run(), status=status, deliveryStatus='delivered')
            result = normalize_run(raw)
            self.assertEqual(result['processing'], processing)
            self.assertEqual(result['delivery'], 'sent')
        raw = run(); del raw['runId']
        self.assertEqual(normalize_run(raw)['identity'], 'cron:job1:1000')

    def test_send_actual_builder_shape_and_argv(self):
        receipt = {'action': 'send', 'channel': 'telegram', 'dryRun': False,
                   'handledBy': 'plugin', 'messageId': '42',
                   'payload': {'ok': True, 'messageId': '42', 'chatId': 'PRIVATE'}}
        result = self.adapter({'*': {'json': receipt}}).send_owner('owner-fixture', 'hello ; $(no)')
        self.assertEqual(result.outcome, 'sent')
        self.assertEqual(result.evidence, 'provider_message_id')
        self.assertNotIn('PRIVATE', repr(result))
        self.assertEqual(self.argv(), [['message', 'send', '--channel', 'telegram',
                                      '--target', 'owner-fixture', '--message', 'hello ; $(no)', '--json']])

    def test_send_conservative_evidence(self):
        base = dict(action='send', channel='telegram', dryRun=False, handledBy='plugin')
        for extra, expected in [({'payload': {'chatId': '42'}}, 'unknown'),
                                ({'payload': {'status': 'queued', 'messageId': '42'}}, 'queued'),
                                ({'messageId': '42', 'ok': False}, 'failed'),
                                ({'messageId': '42', 'deliveryStatus': 'partial_failed'}, 'partial_failed'),
                                ({'messageId': '42', 'payload': {'result': {'ok': False}}}, 'failed'),
                                ({'messageId': '42', 'dryRun': True}, 'unknown'),
                                ({'messageId': '42', 'channel': 'slack'}, 'unknown'),
                                ({'messageId': '42', 'deliveryStatus': 'new_state'}, 'unknown'),
                                ({'payload': {'result': {'messageId': '42'}}}, 'sent'),
                                ({'messageId': '42', 'payload': {'messageId': '43'}}, 'unknown')]:
            with self.subTest(extra=extra):
                result = parse_send_result(dict(base, **extra))
                self.assertEqual(result.outcome, expected)
                self.assertFalse(result.retry_safe)

    def test_send_transport_never_safe_to_retry(self):
        for reply in ({'sleep': .5}, {'exit': 1, 'stderr': 'SECRET'}, {'stdout': '{bad'}):
            result = self.adapter({'*': reply}, timeout=.05).send_owner('fixture', 'alert')
            self.assertEqual(result.outcome, 'unknown')
            self.assertFalse(result.retry_safe)
            self.assertNotIn('SECRET', repr(result))
        result = NativeAdapter(('/nonexistent/pantheon-fixture',)).send_owner('fixture', 'alert')
        self.assertTrue(result.retry_safe)

    def test_failure_json_on_real_adapter_is_not_optimistic(self):
        for exit_code in (0, 1):
            result = self.adapter({'*': {'exit': exit_code, 'json': {
                'action': 'send', 'channel': 'telegram', 'dryRun': False,
                'ok': False, 'deliveryStatus': 'partial_failed', 'messageId': '42',
                'error': {'message': 'SECRET'}}}}).send_owner('fixture', 'alert')
            self.assertEqual(result.outcome, 'partial_failed')
            self.assertNotIn('SECRET', repr(result))

    def test_malformed_status_and_nested_failure_are_safe(self):
        for changes in ({'status': {}}, {'deliveryStatus': []}):
            result = self.adapter({'*': {'json': page([dict(run(), **changes)])}}).runs()
            self.assertEqual(result.error.category, 'schema_drift')
        for reply in ({'json': {'action': 'send', 'channel': 'telegram', 'dryRun': False,
                               'messageId': '42', 'payload': {'status': 'failed'}}},):
            result = self.adapter({'*': reply}).send_owner('fixture', 'alert')
            self.assertEqual(result.outcome, 'failed')

    def test_pagination_second_source_failure_retains_partial_evidence(self):
        result = self.adapter({
            'cron runs --all --limit 2 --offset 0 --sort desc':
                {'json': page([run('r3'), run('r2')], total=3, more=True)},
            'cron runs --all --limit 2 --offset 2 --sort desc':
                {'exit': 1, 'stderr': 'SECRET'}}).runs(page_size=2)
        self.assertFalse(result.available)
        self.assertFalse(result.complete)
        self.assertEqual(len(result.records), 2)
        self.assertIn('source_unavailable', result.gaps)

    def test_stderr_is_bounded_too(self):
        result = self.adapter({'*': {'stderr': 'SECRET' * 1000}}, max_output_bytes=1000).jobs()
        self.assertEqual(result.error.category, 'output_limit')

    def test_explicit_numeric_route_contradiction_is_not_sent(self):
        result = self.adapter({'*': {'json': {
            'action': 'send', 'channel': 'telegram', 'dryRun': False,
            'messageId': '42', 'payload': {'chatId': '999'}}}}).send_owner('123', 'alert')
        self.assertEqual(result.outcome, 'unknown')

    def test_job_projection_redacts_payload_and_routing(self):
        result = self.adapter({'*': {'json': {'jobs': [{
            'id': 'job', 'enabled': True, 'agentId': 'main',
            'payload': {'text': 'SECRET'}, 'delivery': {'to': 'SECRET'},
            'name': 'PRIVATE'}]}}}).jobs()
        self.assertEqual(result.records, ({'id': 'job', 'enabled': True, 'agent_id': 'main', 'running_at_ms': None},))

    def test_expected_skip_and_intentional_suppression_are_not_failures(self):
        skipped = normalize_run(dict(run(), status='skipped', error='empty-heartbeat-file',
                                     deliveryStatus='not-requested'))
        self.assertNotEqual(skipped['processing'], 'failed')
        suppressed = normalize_run(dict(run(), completionStatus='succeeded',
                                        deliverySuppressionReason='no_visible_payload'))
        self.assertEqual(suppressed['delivery'], 'suppressed')
        self.assertEqual(suppressed['completion'], 'succeeded')
        unexpected = normalize_run(dict(run(), status='skipped', error='unexpected SECRET'))
        self.assertEqual(unexpected['completion'], 'failed')
        self.assertFalse(unexpected['informational'])
        self.assertNotIn('SECRET', repr(unexpected))
        independent_failure = normalize_run(dict(run(), status='skipped', error='empty-heartbeat-file',
                                                deliveryError='SECRET'))
        self.assertFalse(independent_failure['informational'])

    def test_running_job_and_malformed_delivered(self):
        result = self.adapter({'*': {'json': {'jobs': [dict(id='job', enabled=True,
            state={'runningAtMs': 1000, 'lastError': 'SECRET'})]}}}).jobs()
        self.assertEqual(result.records[0]['running_at_ms'], 1000)
        for changes in ({'delivered': 'false'}, {'completionStatus': {}}, {'status': True}):
            result = self.adapter({'*': {'json': page([dict(run(), deliveryStatus='delivered', **changes)])}}).runs()
            self.assertFalse(result.available)

    def test_invalid_bounds_and_inputs_before_dispatch(self):
        for kwargs in ({'timeout': 0}, {'max_output_bytes': 0}, {'executable': ()}):
            with self.assertRaises(ValueError):
                NativeAdapter(**kwargs)
        adapter = self.adapter({})
        for kwargs in ({'page_size': 201}, {'max_pages': 0}):
            with self.assertRaises(ValueError):
                adapter.runs(**kwargs)
        with self.assertRaises(ValueError):
            adapter.send_owner('--bad', 'alert')
        self.assertFalse(self.log.exists())


if __name__ == '__main__':
    unittest.main()
