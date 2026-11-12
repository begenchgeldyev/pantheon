#!/bin/bash
# Isolated passive packaging fixture: every destination and executable is explicit.
set -euo pipefail
cd "$(dirname "$0")/.."
PYTHONDONTWRITEBYTECODE=1 python3 - <<'PY'
import json, os, pathlib, shutil, stat, subprocess, tempfile

repo = pathlib.Path.cwd()
with tempfile.TemporaryDirectory(prefix='pantheon-install-', dir=os.environ.get('TMPDIR', '/tmp/opencode')) as tmp:
    root = pathlib.Path(tmp)
    source = root/'source'
    # Copy production inputs and installer only, never fixtures/private notes.
    files = ['bin/install-pantheon-helpers', 'bin/install-remind-wrappers',
             'bin/standup-intake', 'bin/pantheon-state', 'bin/pantheon-status', 'bin/pantheon-check',
             'bin/pantheon_ops/__init__.py', 'bin/pantheon_ops/state.py',
             'bin/pantheon_ops/native.py', 'bin/pantheon_ops/monitor.py',
             'laptop/seneca-standup', 'laptop/seneca-standup.service', 'laptop/seneca-standup.timer',
             'server/pantheon-check.service', 'server/pantheon-check.timer']
    files += ['bin/remind-impl/'+n for n in ['remind', 'remind-in', 'remind-cron', 'remind-list', 'remind-rm', 'remind-lib']]
    files += ['plugins/pantheon-message-guard/'+n for n in ['index.ts', 'validator.ts', 'package.json', 'openclaw.plugin.json', 'README.md']]
    for name in files:
        dest = source/name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(repo/name, dest)
    fakebin = root/'fakebin'; fakebin.mkdir()
    native_log = root/'native.log'
    # Any implicit activation/native call makes the fixture fail.
    for name in ['systemctl', 'openclaw', 'bun', 'npm', 'ssh', 'opencode']:
        p = fakebin/name
        p.write_text('#!/bin/sh\necho forbidden >> "$FORBIDDEN_LOG"\nexit 99\n'); p.chmod(0o755)
    env = dict(os.environ, PATH=str(fakebin)+':'+os.environ['PATH'], FORBIDDEN_LOG=str(native_log), PYTHONDONTWRITEBYTECODE='1')
    installer = source/'bin/install-pantheon-helpers'
    def run(*args, code=0, extra=None):
        result = subprocess.run(list(map(str,args)), env=dict(env, **(extra or {})), capture_output=True, text=True, timeout=15)
        assert result.returncode == code, (args, result.returncode, result.stdout, result.stderr)
        return result
    def install(mode, dest, units=None, code=0):
        return run('bash', installer, mode, dest, *([units] if units else []), code=code)
    # A late missing input must fail before even creating the destination.
    missing = source/'bin/pantheon_ops/monitor.py'
    saved = missing.read_bytes(); missing.unlink()
    install('server', root/'missing-bin', root/'missing-units', code=2)
    assert not (root/'missing-bin').exists() and not (root/'missing-units').exists()
    missing.write_bytes(saved)
    for mode, name in [('laptop','laptop/seneca-standup.timer'), ('plugin','plugins/pantheon-message-guard/openclaw.plugin.json')]:
        missing = source/name; saved = missing.read_bytes(); missing.unlink()
        dest, unitdest = root/(mode+'-missing'), root/(mode+'-missing-units')
        install(mode, dest, unitdest if mode == 'laptop' else None, code=2)
        assert not dest.exists() and not unitdest.exists()
        missing.write_bytes(saved)
    install('server', 'relative', root/'units', code=2)
    server, units = root/'server-bin', root/'server-units'
    (server/'remind-impl').mkdir(parents=True)
    owner = server/'remind-impl/owner-chat'; owner.write_text('123456789\n'); owner.chmod(0o600)
    wrapper = server/'remind'; wrapper.write_text('preexisting owner wrapper\n'); wrapper.chmod(0o750)
    before = (owner.read_bytes(), owner.stat().st_mode, wrapper.read_bytes(), wrapper.stat().st_mode)
    install('server', server, units)
    assert before == (owner.read_bytes(), owner.stat().st_mode, wrapper.read_bytes(), wrapper.stat().st_mode)
    assert sorted(p.name for p in (server/'pantheon_ops').iterdir()) == ['__init__.py','monitor.py','native.py','state.py']
    assert sorted(p.name for p in units.iterdir()) == ['pantheon-check.service','pantheon-check.timer']
    for p in server.rglob('*'):
        if p.is_file() and p not in (owner, wrapper):
            expected = 0o644 if p.suffix == '.py' or p.name == 'remind-lib' else 0o755
            assert stat.S_IMODE(p.stat().st_mode) == expected, p
    assert all(stat.S_IMODE(p.stat().st_mode) == 0o644 for p in units.iterdir())
    # Existing wrapper generator still pins agent and defaults to the same path.
    generated = root/'agent-wrappers'
    clean = dict(env); clean.pop('REMIND_IMPL_DIR', None)
    result = subprocess.run([str(server/'install-remind-wrappers'), 'seneca', str(generated)], env=clean, capture_output=True, timeout=5)
    assert result.returncode == 0
    assert (generated/'remind-in').read_text() == '#!/bin/sh\nexec /home/openclaw/bin/remind-impl/remind-in seneca "$@"\n'
    # Real installed entrypoints resolve their adjacent production imports.
    run(server/'pantheon-state', '--state-dir', root/'state', 'status', '2026-11-12')
    run(server/'standup-intake', 'not-a-date', code=2)
    assert not (root/'state').exists()
    fake = root/'fake-native'
    fake.write_text('''#!/usr/bin/env python3
import json, sys
args = sys.argv[1:]
if args == ['agents','list','--json']: value = [{'id':'main','isDefault':True}]
elif args == ['cron','list','--all','--json']: value = {'jobs':[]}
elif args == ['cron','runs','--all','--limit','50','--offset','0','--sort','desc']: value = {'entries':[], 'total':0, 'offset':0, 'limit':50, 'hasMore':False, 'nextOffset':None}
else: raise SystemExit(99)
print(json.dumps(value))
'''); fake.chmod(0o755)
    common = ['--json','--state-dir',root/'state','--workspace',root/'workspace','--owner-chat-file',owner,'--native-executable',fake]
    run(server/'pantheon-status', *common)
    assert not (root/'state').exists()
    run(server/'pantheon-check', *common, code=2)  # no implicit baseline or send
    assert not (root/'state/monitor/state.json').exists()  # checker may create its lock
    laptop, laptop_units = root/'laptop-bin', root/'laptop-units'
    install('laptop', laptop, laptop_units)
    assert sorted(p.name for p in (laptop/'pantheon_ops').iterdir()) == ['__init__.py','state.py']
    assert sorted(p.name for p in laptop_units.iterdir()) == ['seneca-standup.service','seneca-standup.timer']
    assert all(stat.S_IMODE(p.stat().st_mode) == 0o644 for p in laptop_units.iterdir())
    for p in laptop.rglob('*'):
        if p.is_file(): assert stat.S_IMODE(p.stat().st_mode) == (0o644 if p.suffix == '.py' else 0o755), p
    run(laptop/'seneca-standup', '--status', extra={'SENECA_STATE_HELPER':str(laptop/'pantheon-state'), 'SENECA_STATE_DIR':str(root/'laptop-state'), 'SENECA_DATE':'2026-11-12'})
    assert not (root/'laptop-state').exists()
    plugin = root/'plugin-package'
    install('plugin', plugin)
    assert sorted(p.name for p in plugin.iterdir()) == ['README.md','index.ts','openclaw.plugin.json','package.json','validator.ts']
    assert all(stat.S_IMODE(p.stat().st_mode) == 0o644 for p in plugin.iterdir())
    assert not native_log.exists(), 'implicit activation/native command'
    assert not list(root.rglob('__pycache__')), 'unexpected runtime artifacts'
print('OK: passive server/laptop/plugin packaging; installed imports; no activation')
PY
