import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const script = resolve(import.meta.dirname, '../delete.sh');

function run({
  pr = '7251',
  environments = [],
  listingFails = false,
  deleteStatus = {},
  project,
  dryRun,
}) {
  const directory = mkdtempSync(join(tmpdir(), 'cleanup-railway-'));
  try {
    const output = join(directory, 'output');
    const calls = join(directory, 'calls');
    writeFileSync(output, '');
    writeFileSync(calls, '');
    writeFileSync(
      join(directory, 'fixture.json'),
      JSON.stringify({ environments, listingFails, deleteStatus }),
    );
    writeFileSync(
      join(directory, 'gh'),
      `#!${process.execPath}\nimport { readFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(args) + '\\n');
const { environments, listingFails, deleteStatus } = JSON.parse(readFileSync(process.env.FIXTURE_DATA, 'utf8'));
if (args[0] === 'api' && args[1] === 'repos/fixture/repo/environments') {
  if (listingFails) { process.stderr.write('gh: Forbidden (HTTP 403)\\n'); process.exit(1); }
  process.stdout.write(environments.join('\\n') + (environments.length ? '\\n' : ''));
} else if (args[0] === 'api' && args[1] === '-X' && args[2] === 'DELETE') {
  const encoded = args[3].replace('repos/fixture/repo/environments/', '');
  const status = deleteStatus[encoded] ?? 204;
  if (status >= 400) { process.stderr.write('gh: failure (HTTP ' + status + ')\\n'); process.exit(1); }
} else { process.stderr.write('Unexpected: ' + JSON.stringify(args)); process.exit(2); }
`,
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      GH_TOKEN: 'fixture-token',
      PR_NUMBER: pr,
      REPOSITORY: 'fixture/repo',
      GITHUB_OUTPUT: output,
      FIXTURE_CALLS: calls,
      FIXTURE_DATA: join(directory, 'fixture.json'),
    };
    if (project !== undefined) env.RAILWAY_PROJECT = project;
    if (dryRun !== undefined) env.DRY_RUN = dryRun;
    const result = spawnSync('bash', [script], { env, encoding: 'utf8', timeout: 10000 });
    const recorded = readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return {
      status: result.status,
      stdout: result.stdout,
      output: readFileSync(output, 'utf8'),
      deletes: recorded.filter((args) => args[2] === 'DELETE').map((args) => args[3]),
      calls: recorded,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const path = (encoded) => `repos/fixture/repo/environments/${encoded}`;
const keep = [
  'buildy / charming-pr-17251',
  'buildy / charming-pr-72510',
  'buildy / production',
  'buildy / staging',
  'Preview – charming-www',
];

describe('cleanup-railway-preview-environment', () => {
  it('deletes both Railway name formats for the pull request and nothing else', () => {
    const result = run({
      environments: [...keep, 'buildy / charming-pr-7251', 'buildy / pr-189c05-7251'],
    });
    assert.equal(result.status, 0);
    assert.deepEqual(result.deletes, [
      path('buildy%20%2F%20charming-pr-7251'),
      path('buildy%20%2F%20pr-189c05-7251'),
    ]);
    assert.equal(
      result.output,
      'deleted<<EOF\nbuildy / charming-pr-7251\nbuildy / pr-189c05-7251\nEOF\n',
    );
  });

  it('deletes nothing when no environment matches', () => {
    const result = run({ environments: keep });
    assert.equal(result.status, 0);
    assert.deepEqual(result.deletes, []);
    assert.equal(result.output, 'deleted<<EOF\nEOF\n');
  });

  it('succeeds on an empty listing', () => {
    const result = run({ environments: [] });
    assert.equal(result.status, 0);
    assert.deepEqual(result.deletes, []);
    assert.equal(result.output, 'deleted<<EOF\nEOF\n');
  });

  for (const pr of ['0', 'abc', '-5', '12a']) {
    it(`rejects pull request number ${pr} before calling gh`, () => {
      const result = run({ pr, environments: ['buildy / charming-pr-0'] });
      assert.notEqual(result.status, 0);
      assert.deepEqual(result.calls, []);
    });
  }

  it('fails when the environment listing fails', () => {
    const result = run({ listingFails: true });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.deletes, []);
  });

  it('counts an already-deleted environment as deleted and continues', () => {
    const result = run({
      environments: ['buildy / charming-pr-7251', 'buildy / pr-189c05-7251'],
      deleteStatus: { 'buildy%20%2F%20charming-pr-7251': 404 },
    });
    assert.equal(result.status, 0);
    assert.equal(result.deletes.length, 2);
    assert.equal(
      result.output,
      'deleted<<EOF\nbuildy / charming-pr-7251\nbuildy / pr-189c05-7251\nEOF\n',
    );
  });

  it('continues past a server error and exits non-zero', () => {
    const result = run({
      environments: ['buildy / charming-pr-7251', 'buildy / pr-189c05-7251'],
      deleteStatus: { 'buildy%20%2F%20charming-pr-7251': 500 },
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.deletes.length, 2);
    assert.equal(result.output, 'deleted<<EOF\nbuildy / pr-189c05-7251\nEOF\n');
  });

  it('with railway-project set, deletes only that project and keeps others', () => {
    const result = run({
      project: 'buildy',
      environments: ['other / charming-pr-7251', 'buildy / charming-pr-7251'],
    });
    assert.equal(result.status, 0);
    assert.deepEqual(result.deletes, [path('buildy%20%2F%20charming-pr-7251')]);
    assert.equal(result.output, 'deleted<<EOF\nbuildy / charming-pr-7251\nEOF\n');
  });

  it('does not match a project that merely starts with the given name', () => {
    const result = run({
      project: 'buildy',
      environments: ['buildy-two / charming-pr-7251'],
    });
    assert.equal(result.status, 0);
    assert.deepEqual(result.deletes, []);
  });

  it('matches a project name with regex characters literally', () => {
    const result = run({
      project: 'a.c+',
      environments: ['abcc / charming-pr-7251', 'a.c+ / charming-pr-7251'],
    });
    assert.equal(result.status, 0);
    assert.deepEqual(result.deletes, [path('a.c%2B%20%2F%20charming-pr-7251')]);
    assert.equal(result.output, 'deleted<<EOF\na.c+ / charming-pr-7251\nEOF\n');
  });

  it('in a dry run, makes no DELETE calls and outputs the names it would delete', () => {
    const result = run({
      dryRun: 'true',
      environments: [...keep, 'buildy / charming-pr-7251', 'buildy / pr-189c05-7251'],
    });
    assert.equal(result.status, 0);
    assert.deepEqual(result.deletes, []);
    assert.match(result.stdout, /Would delete buildy \/ charming-pr-7251/);
    assert.equal(
      result.output,
      'deleted<<EOF\nbuildy / charming-pr-7251\nbuildy / pr-189c05-7251\nEOF\n',
    );
  });
});
