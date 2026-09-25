// phix 服务器候选：内置**只放公网入口**。
// 内网自建地址不入库 —— 写进源码等于把内网拓扑发到公开仓库。
// 部署者想指定自己的服务器，两种方式（都不需要改代码）：
//   1. 环境变量 PHIX_LAN_SERVER=http://<内网地址>:<端口>
//   2. 项目根/程序目录放一个 .phix-local.json： {"lanServer":"http://..."}
// 该文件已加入 .gitignore；打包时不进 asar。

const PUBLIC_DEFAULT = 'https://phix.ing/api/v1';

function readLocalOverride() {
  const candidates = [];
  try { candidates.push(process.cwd()); } catch { /* ignore */ }
  try {
    if (typeof __dirname === 'string') {
      candidates.push(__dirname);            // electron/ （开发时）
      candidates.push(require('node:path').join(__dirname, '..')); // 打包后 resources/
    }
  } catch { /* ignore */ }
  for (const dir of candidates) {
    try {
      const p = require('node:path').join(dir, '.phix-local.json');
      const j = JSON.parse(require('node:fs').readFileSync(p, 'utf8'));
      const v = String(j && j.lanServer || '').trim();
      if (v) return v;
    } catch { /* 文件不存在/格式错 → 跳过 */ }
  }
  return '';
}

/** 首选地址：本机内网实例（若配置了）优先，否则公网入口。 */
function defaultServer() {
  return (String(process.env.PHIX_LAN_SERVER || '').trim()) || readLocalOverride() || PUBLIC_DEFAULT;
}

/** 探测候选顺序：内网 → 公网。去重、过滤空值。 */
function serverCandidates() {
  return [...new Set([defaultServer(), PUBLIC_DEFAULT].filter(Boolean))];
}

module.exports = { defaultServer, serverCandidates, PUBLIC_DEFAULT };
