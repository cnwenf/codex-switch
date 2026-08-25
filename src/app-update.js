import path from 'node:path';

const RELEASE_TAG_RE = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
const DOWNLOAD_ROOT = 'https://github.com/cnwenf/codex-switch/releases/download';
const INSTALLER_ENV_ALLOWLIST = Object.freeze([
  'HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);

function parseVersion(value, { requireTag = false } = {}) {
  const input = String(value || '');
  const candidate = requireTag ? input : `v${input.replace(/^v/, '')}`;
  const match = RELEASE_TAG_RE.exec(candidate);
  if (!match) throw new Error('invalid release tag or version');
  return {
    tag: candidate,
    version: candidate.slice(1),
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareIdentifiers(left, right) {
  const leftNumber = /^[0-9]+$/.test(left) ? Number(left) : null;
  const rightNumber = /^[0-9]+$/.test(right) ? Number(right) : null;
  if (leftNumber !== null && rightNumber !== null) return Math.sign(leftNumber - rightNumber);
  if (leftNumber !== null) return -1;
  if (rightNumber !== null) return 1;
  return left === right ? 0 : (left > right ? 1 : -1);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) {
      return Math.sign(left.numbers[index] - right.numbers[index]);
    }
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length ? -1 : 1;
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const comparison = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (comparison) return comparison;
  }
  return 0;
}

function exactUploadedAsset(assets, name, tag) {
  const expectedUrl = `${DOWNLOAD_ROOT}/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
  const named = assets.filter((asset) => asset && asset.name === name);
  if (named.length !== 1) return null;
  const [asset] = named;
  return asset.state === 'uploaded' && asset.browser_download_url === expectedUrl ? asset : null;
}

export function summarizeReleaseUpdate(release, currentVersion) {
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    throw new Error('invalid release metadata');
  }
  const latest = parseVersion(release.tag_name, { requireTag: true });
  const current = parseVersion(currentVersion);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const assetName = `CodexSwitch-${latest.version}-macos-arm64.dmg`;
  const checksumName = `${assetName}.sha256`;
  const asset = exactUploadedAsset(assets, assetName, latest.tag);
  const checksum = exactUploadedAsset(assets, checksumName, latest.tag);
  const assetsReady = Boolean(asset && checksum);

  return {
    current: current.version,
    latest: latest.version,
    tag: latest.tag,
    newer: compareVersions(latest, current) > 0,
    assetsReady,
    assetName: assetsReady ? assetName : null,
    checksumName: assetsReady ? checksumName : null,
    assetUrl: assetsReady ? asset.browser_download_url : null,
    checksumUrl: assetsReady ? checksum.browser_download_url : null,
    assetSize: assetsReady && Number.isSafeInteger(asset.size) && asset.size >= 0 ? asset.size : 0,
    releaseUrl: `https://github.com/cnwenf/codex-switch/releases/tag/${encodeURIComponent(latest.tag)}`,
  };
}

export function buildInstallerCommand(repoRoot, tag) {
  parseVersion(tag, { requireTag: true });
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot) || /[\0\r\n]/.test(repoRoot)) {
    throw new Error('invalid installer root');
  }
  return {
    file: '/bin/sh',
    args: [path.join(repoRoot, 'scripts', 'install-app.sh'), '--release-tag', tag],
  };
}

export function buildInstallerEnvironment(environment = {}, secretNames = new Set()) {
  const output = {};
  for (const name of INSTALLER_ENV_ALLOWLIST) {
    if (!secretNames.has(name) && typeof environment[name] === 'string') output[name] = environment[name];
  }
  output.CODEX_SWITCH_INSTALL_NO_APP_CONTROL = '1';
  return output;
}
