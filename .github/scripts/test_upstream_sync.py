"""Exercise the updater against disposable repositories; no GitHub/network writes."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('prepare-upstream.sh').resolve()


class UpstreamSyncTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = dict(os.environ, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1',
                        GIT_AUTHOR_NAME='Fixture', GIT_AUTHOR_EMAIL='fixture@example.test',
                        GIT_COMMITTER_NAME='Fixture', GIT_COMMITTER_EMAIL='fixture@example.test')
        self.upstream = self.root / 'upstream'
        self.git('init', '-b', 'main', str(self.upstream))
        self.commit(self.upstream, 'common.txt', 'original\n')
        self.origin = self.root / 'origin.git'
        self.git('clone', '--bare', str(self.upstream), str(self.origin))
        self.work = self.root / 'work'
        self.git('clone', str(self.origin), str(self.work))
        self.git('switch', '-c', 'selfhost/pocket-id', cwd=self.work)
        self.commit(self.work, 'local.txt', 'self-hosting patch\n')
        self.git('push', 'origin', 'selfhost/pocket-id', cwd=self.work)
        self.base = self.git('rev-parse', 'HEAD', cwd=self.work)
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        gh = bin_dir / 'gh'
        gh.write_text('''#!/usr/bin/env python3
import os, sys
if sys.argv[1:3] == ['pr', 'list']:
    if '--state' in sys.argv and sys.argv[sys.argv.index('--state')+1] == 'closed':
        print(os.environ.get('FIXTURE_CLOSED', '0'))
    else:
        print(os.environ.get('FIXTURE_OPEN', ''))
elif sys.argv[1:3] == ['pr', 'ready']:
    with open(os.environ['FIXTURE_EVENTS'], 'a') as stream:
        stream.write('draft\\n')
else:
    raise SystemExit('Unexpected gh call: '+repr(sys.argv[1:]))
''')
        gh.chmod(0o755)
        self.env.update(PATH=str(bin_dir)+os.pathsep+self.env['PATH'],
                        UPSTREAM_URL=str(self.upstream), GITHUB_OUTPUT=str(self.root/'outputs'),
                        GITHUB_STEP_SUMMARY=str(self.root/'summary'),
                        FIXTURE_EVENTS=str(self.root/'events'))

    def git(self, *args, cwd=None):
        return subprocess.check_output(['git', *args], cwd=cwd or self.root,
                                       env=self.env, stderr=subprocess.PIPE, text=True).strip()

    def commit(self, repo, name, content):
        (repo/name).write_text(content)
        self.git('add', name, cwd=repo)
        self.git('commit', '-m', 'Update '+name, cwd=repo)

    def run_sync(self, success=True):
        Path(self.env['GITHUB_OUTPUT']).write_text('')
        result = subprocess.run(['bash', str(SCRIPT)], cwd=self.work, env=self.env,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, success, result.stdout+result.stderr)
        return dict(line.split('=', 1) for line in Path(self.env['GITHUB_OUTPUT']).read_text().splitlines())

    def test_no_update_skips_proposal_and_can_validate_current_revision(self):
        output = self.run_sync()
        self.assertEqual(output['changed'], 'false')
        self.assertNotIn('head', output)
        self.env['VALIDATE_CURRENT'] = 'true'
        self.assertEqual(self.run_sync()['head'], self.base)

    def test_merge_preserves_local_patch_and_never_moves_deployment_branch(self):
        self.commit(self.upstream, 'upstream.txt', 'new upstream feature\n')
        upstream_sha = self.git('rev-parse', 'HEAD', cwd=self.upstream)
        output = self.run_sync()
        self.assertEqual(output['changed'], 'true')
        self.assertEqual(self.git('show', output['head']+':local.txt', cwd=self.work), 'self-hosting patch')
        self.assertEqual(self.git('show', output['head']+':upstream.txt', cwd=self.work), 'new upstream feature')
        self.assertEqual(self.git('rev-parse', 'refs/heads/selfhost/pocket-id', cwd=self.origin), self.base)
        self.git('merge-base', '--is-ancestor', upstream_sha, output['head'], cwd=self.work)
        self.assertEqual(len(self.git('rev-list', '--parents', '-n', '1', output['head'], cwd=self.work).split()), 3)
        # Retry a previously pushed proposal after checks failed, without force-pushing.
        self.git('switch', 'selfhost/pocket-id', cwd=self.work)
        self.git('branch', '-D', output['branch'], cwd=self.work)
        repeated = self.run_sync()
        self.assertEqual(repeated['head'], output['head'])

    def test_existing_pr_keeps_human_changes_and_is_drafted_before_update(self):
        branch = 'automation/upstream-existing'
        self.git('switch', '-c', branch, cwd=self.work)
        self.commit(self.work, 'human.txt', 'manual conflict resolution\n')
        human = self.git('rev-parse', 'HEAD', cwd=self.work)
        self.git('push', 'origin', branch, cwd=self.work)
        self.git('switch', 'selfhost/pocket-id', cwd=self.work)
        self.git('branch', '-D', branch, cwd=self.work)
        self.env['FIXTURE_OPEN'] = json.dumps(dict(headRefName=branch, number=7, isDraft=False))
        self.commit(self.upstream, 'upstream.txt', 'feature\n')
        output = self.run_sync()
        self.assertEqual(output['branch'], branch)
        self.git('merge-base', '--is-ancestor', human, output['head'], cwd=self.work)
        self.assertEqual((self.root/'events').read_text(), 'draft\n')

    def test_conflicts_abort_without_pushing_changes(self):
        self.commit(self.work, 'common.txt', 'local edit\n')
        self.git('push', 'origin', 'selfhost/pocket-id', cwd=self.work)
        self.commit(self.upstream, 'common.txt', 'upstream edit\n')
        before = self.git('show-ref', cwd=self.origin)
        output = self.run_sync(success=False)
        self.assertEqual(self.git('show-ref', cwd=self.origin), before)
        self.assertEqual(output['changed'], 'false')
        self.assertIn('common.txt', (self.root/'summary').read_text())
        self.assertFalse((self.work/'.git/MERGE_HEAD').exists())

    def test_closed_proposal_is_not_reopened(self):
        self.commit(self.upstream, 'upstream.txt', 'feature\n')
        self.env['FIXTURE_CLOSED'] = '1'
        self.assertEqual(self.run_sync()['changed'], 'false')
        self.assertIn('leaving it closed', (self.root/'summary').read_text())


if __name__ == '__main__':
    unittest.main()
