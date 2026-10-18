const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

function workflow(name) {
  return yaml.load(fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', name), 'utf8'), { schema: yaml.JSON_SCHEMA });
}

test('former macOS entry stages verified drafts without auto-building on main pushes', () => {
  const stage = workflow('build-macos.yml');
  assert.deepEqual(Object.keys(stage.on), ['workflow_dispatch']);
  const commands = stage.jobs.stage.steps.map(s => s.run || '').join('\n');
  assert.match(commands, /run\.conclusion, 'success'/);
  assert.match(commands, /release\.isDraft, true/);
  assert.match(commands, /sha256\(file\), asset\.sha256/);
  assert.match(commands, /Never replace already staged assets/);
  assert.doesNotMatch(commands, /--clobber|--draft=false/);
});

test('registered manual entry invokes the reviewed build from the same commit without duplicate preview jobs', () => {
  const caller = workflow('build-collaboration.yml');
  const build = workflow('build-v2.yml');
  assert.deepEqual(caller.permissions, { contents: 'read' });
  assert.deepEqual(build.permissions, { contents: 'read' });
  assert.deepEqual(caller.on.pull_request.branches, ['main']);
  assert.equal(caller.jobs.package.if, "github.event_name == 'pull_request'");
  const reviewed = caller.jobs['reviewed-packages'];
  assert.equal(reviewed.if, "github.event_name == 'workflow_dispatch'");
  assert.equal(reviewed.uses, './.github/workflows/build-v2.yml');
  assert.equal(reviewed.secrets, undefined);
  for (const input of ['source_sha', 'version']) {
    assert.equal(caller.on.workflow_dispatch.inputs[input].required, true);
    assert.equal(build.on.workflow_call.inputs[input].required, true);
    assert.equal(reviewed.with[input], '${{ inputs.' + input + ' }}');
  }
  assert.deepEqual(Object.keys(build.on).sort(), ['workflow_call', 'workflow_dispatch']);
});

test('both entry paths compare the shared account UI against a pinned genuine Lite checkout', () => {
  for (const name of ['build-collaboration.yml', 'build-v2.yml']) {
    const job = workflow(name).jobs.package;
    const preserveBytes = job.steps.findIndex(step => step.run === 'git config --global core.autocrlf false');
    const firstCheckout = job.steps.findIndex(step => step.uses?.startsWith('actions/checkout@'));
    assert.ok(preserveBytes >= 0 && preserveBytes < firstCheckout, 'disable platform newline conversion before either source checkout');
    const checkout = job.steps.find(step => step.with?.repository === 'huaziqian40-bot/Pinghe-Launcher-Lite');
    assert.equal(checkout.with.ref, 'cd420f40a05dfae8b3482b851785ba4411d7b48d');
    assert.equal(checkout.with['persist-credentials'], false);
    assert.equal(checkout.with['sparse-checkout'], 'ui/account-ui.js');
    assert.equal(job.env.PHL_LITE_DIR, '${{ github.workspace }}/' + checkout.with.path);
    assert.ok(job.steps.some(step => step.run === 'npm test'));
  }
});
