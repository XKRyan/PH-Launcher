'use strict';
// 诊断：在**真 Electron** 里跑一次学校自动登录（与主进程同一条代码路径：
// createSchoolFetch + SchoolAuthenticator），把每一步的真实结果打出来。
// 只跑一次，不循环、不重试。
//
// 用法： "…\app\PH Launcher.exe" scripts/school-login-probe.cjs <dataDir>
const path = require('node:path');

const dataDir = process.argv[2];
if (!dataDir) {
  console.error('用法: PH Launcher.exe scripts/school-login-probe.cjs <dataDir>');
  process.exit(2);
}

const { app, net, session } = require('electron');
app.disableHardwareAcceleration();

const SITES = {
  edupage: { partition: 'persist:ph-site-edupage' },
  managebac: { partition: 'persist:ph-site-managebac' },
};

async function main() {
  const { SharedAccountStore } = require('../electron/shared-account-store.cjs');
  const { createSchoolFetch } = require('../electron/school-transport.cjs');
  const { SchoolAuthenticator } = require('../electron/school-auth.cjs');

  const store = new SharedAccountStore({
    filePath: path.join(dataDir, 'settings.yaml'),
    siteIds: ['edupage', 'managebac', 'mail'],
  });
  const status = store.status();
  console.log('PROBE 账号:', JSON.stringify(Object.fromEntries(
    Object.entries(status.sites).map(([k, v]) => [k, { saved: v.saved, autoLogin: v.autoLogin }]))));

  const schoolFetch = createSchoolFetch({
    net,
    getSession: (siteId) => session.fromPartition(SITES[siteId].partition, { cache: true }),
  });

  for (const site of ['managebac', 'edupage']) {
    const authenticator = new SchoolAuthenticator({
      fetch: schoolFetch,
      getCredential: (siteId, { manual = false } = {}) => {
        if (!manual) return store.getForLogin(siteId);
        const record = store.getForFill(siteId, { allowDisabled: true });
        return record ? { ...record, autoLogin: true } : null;
      },
    });
    process.stdout.write(`PROBE ${site}: 自动登录中… `);
    const t0 = Date.now();
    try {
      const result = await authenticator.authenticate(site, { manual: false });
      console.log(`OK authenticated=${result.authenticated} 用时 ${Date.now() - t0}ms`);
    } catch (error) {
      const diag = error && error.diagnostic ? ' ' + JSON.stringify(error.diagnostic) : '';
      console.log(`FAIL code=${error && error.code} msg=${error && error.message}${diag} 用时 ${Date.now() - t0}ms`);
    }
  }
}

app.whenReady().then(() => {
  main()
    .catch((error) => console.log('PROBE 崩溃:', error && error.stack ? error.stack.split('\n')[0] : String(error)))
    .finally(() => { setTimeout(() => app.exit(0), 400); });
});
