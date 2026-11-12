import json
import tempfile
import unittest
from pathlib import Path

from state import StateError, classify_agent_result, load_standup


class ParserTests(unittest.TestCase):
    def classify(self, payload, rc=0):
        return classify_agent_result(payload, rc)

    def sent(self, **kwargs):
        return dict(status='sent', requested=True, attempted=True, succeeded=True, **kwargs)

    def test_exit_zero_is_not_receipt(self):
        for payload in ({}, None, 'not json', [], {'text': 'sent'}):
            result = self.classify(payload)
            self.assertEqual(result['processing']['status'], 'unknown')
            self.assertEqual(result['delivery']['status'], 'unknown')

    def test_processing_independent(self):
        for status, expected in [('ok', 'succeeded'), ('completed', 'succeeded'),
                                 ('accepted', 'accepted'), ('in_flight', 'in_flight'),
                                 ('failed', 'failed')]:
            result = self.classify({'status': status, 'runId': 'run-123'})
            self.assertEqual(result['processing']['status'], expected)
            self.assertEqual(result['processing']['run_id'], 'run-123')
            self.assertEqual(result['delivery']['status'], 'unknown')

    def test_native_top_and_nested(self):
        for payload in ({'status': 'ok', 'deliveryStatus': self.sent()},
                        {'result': {'status': 'completed', 'deliveryStatus': self.sent()}}):
            result = self.classify(payload)
            self.assertEqual(result['delivery']['status'], 'sent')
            self.assertEqual(result['processing']['status'], 'succeeded')
            self.assertEqual(result['delivery']['evidence'], 'native_projection')

    def test_delivery_independent_of_processing(self):
        self.assertEqual(self.classify({'status': 'failed', 'deliveryStatus': self.sent()})
                         ['delivery']['status'], 'sent')

    def test_false_ok_envelope_is_processing_counterevidence(self):
        for payload in ({'status': 'ok', 'ok': False},
                        {'status': 'ok', 'result': {'ok': False}},
                        {'result': {'status': 'completed', 'ok': False}},
                        {'status': 'ok', 'ok': False, 'error': {}},
                        {'status': 'ok', 'ok': False, 'error': 'malformed'}):
            with self.subTest(payload=payload):
                self.assertNotEqual(self.classify(payload)['processing']['status'], 'succeeded')
                payload['deliveryStatus'] = self.sent()
                result = self.classify(payload)
                self.assertNotEqual(result['processing']['status'], 'succeeded')
                self.assertEqual(result['delivery']['status'], 'sent')

    def test_delivery_statuses_distinct(self):
        for status in ('suppressed', 'partial_failed', 'failed', 'not_requested'):
            self.assertEqual(self.classify({'deliveryStatus': {'status': status}})
                             ['delivery']['status'], status)

    def test_invalid_and_conflicting(self):
        for delivery in ({'status': 'sent'}, {'status': []}, self.sent(resultCount=0),
                         self.sent(resultCount='1'), self.sent(channel='email'),
                         self.sent(succeededCount=0)):
            self.assertEqual(self.classify({'deliveryStatus': delivery})['delivery']['status'], 'unknown')
        payload = {'status': 'ok', 'deliveryStatus': self.sent(),
                   'result': {'status': 'failed', 'deliveryStatus': {'status': 'failed'}}}
        result = self.classify(payload)
        self.assertNotEqual(result['processing']['status'], 'succeeded')
        self.assertEqual(result['delivery']['status'], 'unknown')
        payload['result']['deliveryStatus'] = 'malformed'
        self.assertEqual(self.classify(payload)['delivery']['status'], 'unknown')

    def test_metadata_redacted(self):
        result = self.classify({'status': 'ok', 'runId': {'secret': 'PRIVATE'},
                               'stderr': 'PRIVATE', 'summary': 'PRIVATE',
                               'deliveryStatus': self.sent(target='PRIVATE')})
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_route_conflicts_and_boolean_types(self):
        for delivery in (self.sent(channel='email'), self.sent(target='other'),
                         dict(status='sent', requested=1, attempted=True, succeeded=True)):
            result = classify_agent_result({'status': 'ok', 'deliveryStatus': delivery}, 0,
                                           expected_target='owner')
            self.assertEqual(result['delivery']['status'], 'unknown')
        result = self.classify({'status': 'ok', 'result': {'status': 'accepted'},
                                'deliveryStatus': self.sent()})
        self.assertEqual(result['processing']['status'], 'unknown')
        self.assertEqual(result['delivery']['status'], 'sent')

    def test_nonzero_preserves_acceptance_and_run(self):
        result = self.classify({'status': 'accepted', 'runId': 'run-after-timeout'}, 124)
        self.assertEqual(result['processing']['status'], 'accepted')
        self.assertEqual(result['processing']['run_id'], 'run-after-timeout')
        self.assertEqual(result['delivery']['status'], 'unknown')


class StateTests(unittest.TestCase):
    def test_missing_and_malformed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertIsNone(load_standup(root, '2026-11-12'))
            path = root / 'standups/2026-11-12/state.json'
            path.parent.mkdir(parents=True)
            for contents in ('{', '[]', '{"version": 2}', '{"version":1,"date":"2026-11-12"}'):
                path.write_text(contents)
                with self.assertRaises(StateError):
                    load_standup(root, '2026-11-12')
            for day in ('../a', '2026-02-30', '2026-1-01'):
                with self.assertRaises(StateError):
                    load_standup(root, day)

    def test_valid_state_and_typed_bad_shapes(self):
        from state import initial, save
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            value = initial('2026-11-12', b'private summary')
            save(root, '2026-11-12', value)
            loaded = load_standup(root, '2026-11-12')
            self.assertEqual(loaded['processing']['status'], 'not_started')
            self.assertNotIn('private summary', json.dumps(loaded))
            path = root / 'standups/2026-11-12/state.json'
            for stage, key, bad in [('processing', 'status', []), ('processing', 'run_id', {}),
                                    ('input', 'stored_at', 42), ('delivery', 'at', 'yesterday')]:
                broken = json.loads(json.dumps(value))
                broken[stage][key] = bad
                path.write_text(json.dumps(broken))
                with self.assertRaises(StateError):
                    load_standup(root, '2026-11-12')


if __name__ == '__main__':
    unittest.main()
