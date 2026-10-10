import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root })
  .toString('utf8').split('\0').filter(Boolean);
const forbiddenNames = [
  'CURRENT_TRUTH.md',
  'docs/CONSOLE_BRIEF.md',
  'docs/CONSOLE_DESIGN_CONTRACT.md',
  'docs/CONSOLE_STYLE_EXPLORATION.md',
  'docs/durable-jobs-runtime-isolation.md',
  'docs/linux-webkit-v067-mobile-review.md',
  'docs/runtime-console-design-review.md',
  'ops/cleanup-legacy-group.ps1',
];
// Split identifiers so this audit does not itself reintroduce them into a
// reusable public repository. All values below are *detection rules*, never
// actual credentials or addresses.
const forbidden = [
  ['project-specific hostname', new RegExp('san' + 'qi[.]org|ph' + 'san' + 'qi', 'i')],
  ['private maintainer alias', new RegExp('san' + 'qi', 'i')],
  ['private Tunnel hostname', new RegExp('cfargo' + 'tunnel[.]com', 'i')],
  ['developer home path', new RegExp('/home/' + 'z/|C:\\\\Users\\\\Administrator', 'i')],
  ['GitHub credential', /gh[pousr]_[a-zA-Z0-9_]{16,}/],
  ['OpenAI-style credential', /sk-[a-zA-Z0-9_-]{20,}/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['authorization secret', /Authorization\s*:\s*Bearer\s+[a-zA-Z0-9._=-]{24,}/i],
  ['real-looking request UUID', new RegExp('(?!00000000-0000-4000-8000-00000000000[0-9])\\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\b', 'i')],
];
const historicalCommitId = /\b[0-9a-f]{40}\b/gi;
const allowedPublicUpstreamCommits = new Map([
  ['ops/video-sidecar-source.json', new Set([
    'bd26828f0e965c2c6575' + '53584b09caf5d57eee52',
    'e0a878dd704698302f45' + '3a8f646e20b21fd1c904',
  ])],
]);

function isPublicSafeGitEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email.endsWith('@users.noreply.github.com') || email.endsWith('@example.com');
}

test('tracked public files contain no private deployment identifiers or known secret formats', () => {
  const problems = [];
  for (const name of tracked) {
    if (forbiddenNames.includes(name)) problems.push(name + ': internal document must not be tracked');
    if (!existsSync(resolve(root, name))) continue; // staged removal during source hygiene
    const data = readFileSync(resolve(root, name));
    const content = data.toString('utf8');
    for (const [label, expression] of forbidden) {
      if (expression.test(content)) problems.push(name + ': ' + label);
    }
    const allowedCommits = allowedPublicUpstreamCommits.get(name);
    for (const match of content.matchAll(historicalCommitId)) {
      const commit = match[0].toLowerCase();
      if (!allowedCommits?.has(commit)) problems.push(name + ': literal historical commit id');
    }
  }
  assert.deepEqual(problems, [], 'Public repository privacy guard failed');
});

test('published website source uses generic configuration instead of a fixed personal site', () => {
  const names = ['site/index.html', 'site/docs/index.html', 'site/sitemap.xml', 'site/robots.txt'];
  for (const name of names) {
    const content = readFileSync(resolve(root, name), 'utf8');
    assert.match(content, /__PUBLIC_SITE_URL__/);
  }
  assert.match(readFileSync(resolve(root, 'ops/cloudflare-gateway-worker.mjs'), 'utf8'), /SERVER_ORIGIN_HOST/);
  assert.match(readFileSync(resolve(root, 'ops/deploy-public-site-linux.sh'), 'utf8'), /DEVSPACE_SITE_PUBLIC_URL/);
});

test('HEAD commit metadata does not publish a personal email address', () => {
  const identity = execFileSync('git', ['show', '-s', '--format=%ae%n%ce', 'HEAD'], { cwd: root })
    .toString('utf8').trim().split(/\r?\n/);
  assert.equal(identity.length, 2, 'Expected author and committer email metadata');
  assert.ok(isPublicSafeGitEmail(identity[0]), 'HEAD author email must use a GitHub noreply or example.com address');
  assert.ok(isPublicSafeGitEmail(identity[1]), 'HEAD committer email must use a GitHub noreply or example.com address');
});
