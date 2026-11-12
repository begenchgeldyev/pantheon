#!/usr/bin/env python3
"""Fixture process only: scenario and argv are supplied by the test environment."""
import json
import os
import sys
import time

with open(os.environ['PANTHEON_FAKE_SCENARIO'], encoding='utf-8') as stream:
    scenario = json.load(stream)
with open(os.environ['PANTHEON_FAKE_LOG'], 'a', encoding='utf-8') as stream:
    stream.write(json.dumps(sys.argv[1:]) + '\n')
key = ' '.join(sys.argv[1:])
reply = scenario.get(key, scenario.get('*', {}))
time.sleep(reply.get('sleep', 0))
sys.stderr.write(reply.get('stderr', ''))
sys.stdout.write(reply.get('stdout', json.dumps(reply.get('json'))))
sys.exit(reply.get('exit', 0))
