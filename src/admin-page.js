function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[character]));
}

export function filterOptions(items, query) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  return needle
    ? items.filter((item) => `${item.name} ${item.id}`.toLocaleLowerCase().includes(needle))
    : items.slice();
}

export function mergeSelectedModels(currentIds, discoveredModels) {
  const byId = new Map(discoveredModels.map((model) => [model.id, model]));
  return [...new Set(currentIds)].map((id) => byId.get(id) || { id, name: id, source: 'manual' });
}

export function getProviderSaveProblem(state) {
  if (!state.routable || state.compatibility === 'unsupported') {
    return '该厂商没有可直连的 Responses API，不能保存为路由。';
  }
  if (state.requiresManualModel) {
    const selected = new Set(Array.isArray(state.modelIds) ? state.modelIds : []);
    const manualIds = Array.isArray(state.manualModelIds) ? state.manualModelIds : [];
    if (!manualIds.some((id) => selected.has(id))) {
      return '发现结果仅供参考，请手动输入可路由的 Endpoint / Deployment ID。';
    }
  }
  if (!Array.isArray(state.modelIds) || state.modelIds.length === 0) {
    return '至少选择或手动添加一个可路由模型。';
  }
  if (state.auth === 'bearer' && !state.hasKey && !state.hasSavedKey) {
    return '请填写 API Key。';
  }
  if (state.validationStatus === 'loading') return '请等待连接检测完成。';
  if (state.validationStatus === 'invalid') return 'API Key 无效，请更正后再保存。';
  if (state.validationStatus === 'unverified' && !state.allowUnverified) {
    return '请先检测连接；Custom、静态目录或已有配置可在未验证时保存。';
  }
  return '';
}

export function deriveProviderBaseUrl(preset, options = {}, customBaseUrl = '') {
  if (!preset) return '';
  if (preset.id === 'custom') return String(customBaseUrl || '').trim();
  if (preset.baseUrl) return preset.baseUrl;
  if (preset.id === 'nvidia-nim') return String(options.base_url || '').trim();
  if (preset.id === 'tencent-tokenhub') {
    return options.site === 'intl'
      ? 'https://tokenhub-intl.tencentcloudmaas.com/v1'
      : 'https://tokenhub.tencentmaas.com/v1';
  }
  if (preset.id === 'bailian') {
    const region = options.region || 'cn-beijing';
    const workspace = String(options.workspace_id || '').trim();
    const host = {
      'cn-beijing': 'dashscope.aliyuncs.com',
      'ap-southeast-1': 'dashscope-intl.aliyuncs.com',
      'us-east-1': 'dashscope-us.aliyuncs.com',
    }[region] || '';
    return workspace
      ? `https://${workspace}.${region}.maas.aliyuncs.com/compatible-mode/v1`
      : (host ? `https://${host}/compatible-mode/v1` : '');
  }
  if (preset.id === 'aws-bedrock') {
    const region = String(options.region || '').trim();
    return region ? `https://bedrock-mantle.${region}.api.aws/v1` : '';
  }
  if (preset.id === 'azure-openai') {
    const endpoint = String(options.resource_endpoint || '')
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/openai\/v1$/, '');
    return endpoint ? `${endpoint}/openai/v1` : '';
  }
  if (preset.id === 'cloudflare-workers-ai') {
    const account = String(options.account_id || '').trim();
    return account ? `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1` : '';
  }
  return '';
}

export function nextOptionIndex(current, length, delta) {
  if (!length) return -1;
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return (current + delta + length) % length;
}

export function combineCapability(first, second) {
  if (first === true || second === true) return true;
  if (first === false && second === false) return false;
  return 'unknown';
}

export function discoveryStatusCopy(status) {
  return {
    loading: { icon: '↻', label: '检测中' },
    valid: { icon: '✓', label: '有效' },
    invalid: { icon: '✕', label: '凭证无效' },
    forbidden: { icon: '!', label: '访问受限' },
    rate_limited: { icon: '!', label: '请求限流' },
    unreachable: { icon: '!', label: '暂时不可达' },
    unverified: { icon: '?', label: '未验证' },
    unsupported: { icon: '✕', label: '发现接口不支持' },
  }[status] || { icon: '?', label: '未验证' };
}

export function shouldCloseModalOnEscape(state) {
  return state.key === 'Escape'
    && !state.defaultPrevented
    && state.modalOpen
    && !state.providerOpen
    && !state.modelOpen;
}

export function shouldConsumeComboboxEscape(key, popupOpen) {
  return key === 'Escape' && Boolean(popupOpen);
}

export function clearSensitiveModalFields(apiKeyInput, importInput) {
  if (apiKeyInput) apiKeyInput.value = '';
  if (importInput) importInput.value = '';
}

export function markDiscoveredModels(models, modelSource, requiresManualModel) {
  const referenceOnly = modelSource === 'manual' && Boolean(requiresManualModel);
  return (Array.isArray(models) ? models : []).map((model) => ({ ...model, referenceOnly }));
}

export function resolveDiscoveryModelSource(modelSource) {
  return ['api', 'static', 'manual'].includes(modelSource)
    ? modelSource
    : 'unknown';
}

export function isModelToggleAllowed(model, isSelected) {
  return Boolean(isSelected) || !model || (!model.referenceOnly && model.responses !== false);
}

export function renderAdminPage({ host, port, version }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>codex-switch · 供应商管理</title>
<style>
:root{
  --color-canvas:oklch(.965 .006 255);
  --color-surface:oklch(.99 .003 255);
  --color-surface-muted:oklch(.945 .008 255);
  --color-surface-hover:oklch(.925 .018 255);
  --color-border:oklch(.84 .015 255);
  --color-border-strong:oklch(.72 .025 255);
  --color-text:oklch(.25 .025 255);
  --color-text-secondary:oklch(.43 .025 255);
  --color-text-muted:oklch(.47 .025 255);
  --color-accent:oklch(.5 .19 255);
  --color-accent-hover:oklch(.44 .19 255);
  --color-accent-soft:oklch(.93 .04 255);
  --color-on-accent:oklch(.985 .004 255);
  --color-success:oklch(.42 .115 150);
  --color-success-soft:oklch(.94 .035 150);
  --color-warning:oklch(.44 .105 75);
  --color-warning-soft:oklch(.94 .04 75);
  --color-error:oklch(.48 .18 25);
  --color-error-soft:oklch(.94 .04 25);
  --color-overlay:oklch(.22 .015 255 / .42);
  --font-sans:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',system-ui,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;
  --font-mono:ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;
  --font-size-title:1.375rem;
  --font-size-section:1rem;
  --font-size-body:.875rem;
  --font-size-metadata:.75rem;
  --line-title:1.75rem;
  --line-section:1.375rem;
  --line-body:1.3125rem;
  --line-metadata:1.125rem;
  --space-1:.25rem;
  --space-2:.5rem;
  --space-3:.75rem;
  --space-4:1rem;
  --space-5:1.5rem;
  --space-6:2rem;
  --space-8:3rem;
  --control-height:2.5rem;
  --control-height-touch:2.75rem;
  --radius-sm:.375rem;
  --radius-md:.625rem;
  --radius-lg:.875rem;
  --radius-full:999px;
  --content-width:70rem;
  --prose-width:72ch;
  --shadow-control:0 1px 2px oklch(.25 .02 255 / .08);
  --shadow-dialog:0 1.5rem 4rem oklch(.22 .02 255 / .22);
}
*{box-sizing:border-box}
html{color-scheme:light;background:var(--color-canvas)}
body{margin:0;min-height:100vh;min-width:0;overflow-x:hidden;color:var(--color-text);font:var(--font-size-body)/var(--line-body) var(--font-sans);background:var(--color-canvas)}
button,input,select,textarea{font:inherit}
::selection{background:var(--color-accent-soft);color:var(--color-text)}
.mono{font-family:var(--font-mono);font-size:var(--font-size-metadata);overflow-wrap:anywhere}
.muted{color:var(--color-text-secondary)}
.ok{color:var(--color-success)}
.err{color:var(--color-error)}
.note{margin:var(--space-1) 0 0;max-width:72ch;font-size:var(--font-size-body);color:var(--color-text-secondary);line-height:var(--line-body);overflow-wrap:anywhere}
.hint{color:var(--color-text-muted);font-size:var(--font-size-metadata);line-height:var(--line-metadata)}

.topbar{position:sticky;top:0;z-index:10;background:var(--color-surface);border-bottom:1px solid var(--color-border)}
.topbar-inner{width:100%;max-width:var(--content-width);margin:0 auto;padding:var(--space-3) var(--space-4);display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:var(--space-4);min-width:0}
.brand{display:flex;align-items:center;gap:var(--space-2);min-width:0}
.brand .logo{width:1.5rem;height:1.5rem;color:var(--color-accent);flex:none}
.brand-copy{display:flex;flex-direction:column;min-width:0}
.brand-name{font-size:var(--font-size-section);line-height:var(--line-section);font-weight:700;letter-spacing:-.01em}
.brand .sub{color:var(--color-text-secondary);font-size:var(--font-size-metadata);line-height:var(--line-metadata);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tabs{display:inline-flex;justify-self:center;gap:var(--space-1);padding:var(--space-1);background:var(--color-surface-muted);border:1px solid var(--color-border);border-radius:var(--radius-md)}
.tabbtn{min-height:var(--control-height);cursor:pointer;font-size:var(--font-size-body);line-height:var(--line-body);color:var(--color-text-secondary);background:transparent;border:1px solid transparent;padding:0 var(--space-4);border-radius:var(--radius-sm);transition:background-color 180ms cubic-bezier(.16,1,.3,1),border-color 180ms cubic-bezier(.16,1,.3,1),color 180ms cubic-bezier(.16,1,.3,1),box-shadow 180ms cubic-bezier(.16,1,.3,1);white-space:nowrap}
.tabbtn:hover{color:var(--color-text);background:var(--color-surface-hover)}
.tabbtn:focus-visible{outline:3px solid var(--color-accent-soft);outline-offset:2px;border-color:var(--color-accent)}
.tabbtn:active{background:var(--color-border)}
.tabbtn.active{background:var(--color-surface);border-color:var(--color-border-strong);color:var(--color-text);font-weight:650;box-shadow:var(--shadow-control)}
.chips{display:flex;justify-content:flex-end;gap:var(--space-2);align-items:center;min-width:0;flex-wrap:wrap}
.chip{font:var(--font-size-metadata)/var(--line-metadata) var(--font-mono);color:var(--color-text-secondary);border:1px solid var(--color-border);background:var(--color-surface-muted);padding:var(--space-1) var(--space-2);border-radius:var(--radius-full);white-space:nowrap}
.runtime-chip{color:var(--color-success);background:var(--color-success-soft);border-color:var(--color-success)}
.dot{display:inline-block;width:.5rem;height:.5rem;border-radius:50%;background:var(--color-text-muted);margin-right:var(--space-1);vertical-align:1px}
.dot.on{background:var(--color-success)}

main{width:100%;max-width:var(--content-width);margin:var(--space-6) auto var(--space-8);padding:0 var(--space-4);min-width:0}
.pane{display:flex;flex-direction:column;gap:var(--space-5);min-width:0}
.pane-head{display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-4);flex-wrap:wrap;min-width:0}
.pane-head > *{min-width:0}
.pane-head h2{margin:0;font-size:var(--font-size-title);line-height:var(--line-title);font-weight:720;letter-spacing:-.025em}
.pane-actions{display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap}

.btn{min-height:var(--control-height);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:var(--font-size-body);line-height:var(--line-body);font-weight:560;color:var(--color-text);background:var(--color-surface);border:1px solid var(--color-border-strong);padding:0 var(--space-4);border-radius:var(--radius-md);box-shadow:var(--shadow-control);transition:background-color 180ms cubic-bezier(.16,1,.3,1),border-color 180ms cubic-bezier(.16,1,.3,1),color 180ms cubic-bezier(.16,1,.3,1),box-shadow 180ms cubic-bezier(.16,1,.3,1),transform 120ms cubic-bezier(.16,1,.3,1);white-space:nowrap}
.btn:hover{background:var(--color-surface-hover);border-color:var(--color-accent);color:var(--color-accent-hover)}
.btn:focus-visible{outline:3px solid var(--color-accent-soft);outline-offset:2px;border-color:var(--color-accent)}
.btn:active{transform:scale(.985);box-shadow:none}
.btn:disabled{cursor:not-allowed;color:var(--color-text-muted);background:var(--color-surface-muted);border-color:var(--color-border);box-shadow:none}
.btn[aria-busy="true"]{cursor:progress;color:var(--color-text-secondary);background:var(--color-surface-muted)}
.btn.primary{background:var(--color-accent);border-color:var(--color-accent);color:var(--color-on-accent);font-weight:680}
.btn.primary:hover{background:var(--color-accent-hover);border-color:var(--color-accent-hover);color:var(--color-on-accent)}
.btn.danger:hover{background:var(--color-error-soft);border-color:var(--color-error);color:var(--color-error)}
.btn.small{min-height:2rem;font-size:var(--font-size-metadata);padding:0 var(--space-3)}

.provider-summary{padding:var(--space-4);background:var(--color-surface-muted);border:1px solid var(--color-border);border-radius:var(--radius-lg)}
.union-bar{font-size:var(--font-size-body);line-height:var(--line-body)}
.union-bar b{color:var(--color-accent)}
.union-chips{display:flex;flex-wrap:wrap;gap:var(--space-2);margin-top:var(--space-3)}
.mtag{display:inline-block;max-width:100%;font:var(--font-size-metadata)/var(--line-metadata) var(--font-mono);padding:var(--space-1) var(--space-2);border-radius:var(--radius-sm);background:var(--color-surface);border:1px solid var(--color-border);color:var(--color-text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.provider-list{display:flex;flex-direction:column;overflow:hidden;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-lg)}
.provider-list > .empty,.history-list > .empty{border:0;border-radius:0;background:transparent}
.pcard{min-width:0;padding:var(--space-4) var(--space-5);display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:var(--space-5);row-gap:var(--space-2);background:var(--color-surface);border-bottom:1px solid var(--color-border);transition:background-color 180ms cubic-bezier(.16,1,.3,1),border-color 180ms cubic-bezier(.16,1,.3,1)}
.pcard:last-child{border-bottom:0}
.pcard:hover{background:var(--color-surface-hover)}
.pcard.off{background:var(--color-surface-muted);border-color:var(--color-border-strong)}
.pcard.off .dot{background:var(--color-text-muted)}
.pcard-top{grid-column:1/-1;display:flex;justify-content:space-between;align-items:center;gap:var(--space-3);min-width:0}
.pcard-id{display:flex;align-items:center;gap:var(--space-2);min-width:0}
.pcard-id b{font-size:var(--font-size-section);line-height:var(--line-section);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pid{max-width:100%;font:var(--font-size-metadata)/var(--line-metadata) var(--font-mono);color:var(--color-text-secondary);background:var(--color-surface-muted);border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:0 var(--space-2);overflow-wrap:anywhere}
.pcard-row{grid-column:1;display:flex;align-items:baseline;gap:var(--space-2);font-size:var(--font-size-body);line-height:var(--line-body);min-width:0}
.pcard-row .lbl{color:var(--color-text-muted);font-size:var(--font-size-metadata);line-height:var(--line-metadata);font-weight:650;text-transform:uppercase;letter-spacing:.06em;flex:none;width:4rem}
.pcard-row .url{color:var(--color-text-secondary);min-width:0}
.url,.cred,.warn-text{min-width:0;overflow-wrap:anywhere;word-break:normal}
.cred{color:var(--color-text-secondary);font:var(--font-size-metadata)/var(--line-metadata) var(--font-mono)}
.warn-text{color:var(--color-warning);font-size:var(--font-size-metadata);line-height:var(--line-metadata)}
.pcard-models{grid-column:1;display:flex;flex-wrap:wrap;gap:var(--space-2);min-height:var(--line-body);min-width:0}
.pcard-actions{grid-column:2;grid-row:2/6;align-self:end;display:flex;gap:var(--space-2)}

.switch{position:relative;display:inline-block;width:2.75rem;height:1.75rem;flex:none}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;inset:0;background:var(--color-border-strong);border-radius:var(--radius-full);transition:background-color 180ms cubic-bezier(.16,1,.3,1);cursor:pointer}
.slider:before{content:'';position:absolute;width:1.125rem;height:1.125rem;left:.3125rem;top:.3125rem;background:var(--color-surface);border-radius:50%;box-shadow:var(--shadow-control);transition:transform 180ms cubic-bezier(.16,1,.3,1)}
.switch input:checked + .slider{background:var(--color-success)}
.switch input:checked + .slider:before{transform:translateX(1rem)}
.switch input:focus-visible + .slider{outline:3px solid var(--color-accent-soft);outline-offset:2px;box-shadow:0 0 0 1px var(--color-accent)}
.switch input:disabled + .slider{cursor:not-allowed;background:var(--color-border)}

.empty{border:1px dashed var(--color-border-strong);border-radius:var(--radius-lg);padding:var(--space-8) var(--space-4);text-align:center;color:var(--color-text-secondary);background:var(--color-surface)}

.history-list{overflow:hidden;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-lg)}
.hrow{display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);padding:var(--space-3) var(--space-4);border-bottom:1px solid var(--color-border);background:var(--color-surface);transition:background-color 180ms cubic-bezier(.16,1,.3,1)}
.hrow:last-child{border-bottom:0}
.hrow:hover{background:var(--color-surface-hover)}
.hinfo{display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap;min-width:0}
.htime{font-weight:650}
.hseq,.hsize{color:var(--color-text-secondary);font-size:var(--font-size-metadata);line-height:var(--line-metadata);font-family:var(--font-mono)}
.hfile{min-width:0;color:var(--color-text-secondary);font-size:var(--font-size-metadata);line-height:var(--line-metadata);overflow-wrap:anywhere}

.settings-section{background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:var(--space-5)}
.card-head{display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap;margin-bottom:var(--space-2)}
.card-head h2{margin:0;font-size:var(--font-size-section);line-height:var(--line-section);font-weight:680}
.status{font-size:var(--font-size-body);line-height:var(--line-body);min-height:var(--line-body);margin-top:var(--space-2);overflow-wrap:anywhere}
.status.err{color:var(--color-error);background:var(--color-error-soft);border-radius:var(--radius-sm);padding:var(--space-2)}
.badge{display:inline-block;font-size:var(--font-size-metadata);line-height:var(--line-metadata);padding:0 var(--space-2);border-radius:var(--radius-full);border:1px solid var(--color-border-strong);color:var(--color-text-secondary);background:var(--color-surface-muted);white-space:nowrap}
.badge.ok{color:var(--color-success);border-color:var(--color-success);background:var(--color-success-soft)}
.badge.warn{color:var(--color-warning);border-color:var(--color-warning);background:var(--color-warning-soft)}
.badge.err{color:var(--color-error);border-color:var(--color-error);background:var(--color-error-soft)}
table{width:100%;border-collapse:collapse;font-size:var(--font-size-body)}
td{padding:var(--space-2) var(--space-3);border-bottom:1px solid var(--color-border);vertical-align:top}
tbody tr:last-child td{border-bottom:none}
.kv td:first-child{color:var(--color-text-muted);width:7.5rem;font-size:var(--font-size-metadata);text-transform:uppercase;letter-spacing:.06em}
#backupList{margin-top:var(--space-3);font-size:var(--font-size-body);color:var(--color-text-secondary)}
#backupList ul{margin:var(--space-2) 0 0;padding-left:1.25rem;columns:2;column-gap:var(--space-6)}
#backupList li{margin:var(--space-1) 0;font:var(--font-size-metadata)/var(--line-metadata) var(--font-mono);color:var(--color-text-secondary);break-inside:avoid}
details{border:1px solid var(--color-border);border-radius:var(--radius-md);padding:var(--space-3) var(--space-4);margin-top:var(--space-3);background:var(--color-surface-muted)}
summary{cursor:pointer;font-size:var(--font-size-body);color:var(--color-text-secondary);user-select:none;list-style:none;display:flex;align-items:center;gap:var(--space-2)}
summary::-webkit-details-marker{display:none}
summary:before{content:'▸';color:var(--color-text-muted);transition:transform 180ms cubic-bezier(.16,1,.3,1);flex:none}
summary:focus-visible{outline:3px solid var(--color-accent-soft);outline-offset:3px;border-radius:var(--radius-sm)}
details[open] summary:before{transform:rotate(90deg)}
.advdet{margin:var(--space-1) 0 var(--space-2)}
.advdet summary{font-size:var(--font-size-metadata);line-height:var(--line-metadata)}
pre{font-family:var(--font-mono);font-size:var(--font-size-metadata);line-height:var(--line-metadata);color:var(--color-text);background:var(--color-surface-muted);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:var(--space-4);overflow:auto;max-height:26.25rem;margin:var(--space-3) 0 0}

#modalWrap{position:fixed;inset:0;z-index:50;background:var(--color-overlay);display:flex;align-items:center;justify-content:center;padding:var(--space-5);overflow:hidden}
#modal{width:min(52rem,100%);max-height:calc(100dvh - 3rem);display:flex;flex-direction:column;overflow:hidden;background:var(--color-surface);border:1px solid var(--color-border-strong);border-radius:var(--radius-lg);box-shadow:var(--shadow-dialog)}
.modal-head{flex:none;display:flex;justify-content:space-between;align-items:center;gap:var(--space-3);min-height:3.5rem;padding:var(--space-3) var(--space-5);background:var(--color-surface);border-bottom:1px solid var(--color-border)}
.modal-head b{min-width:0;font-size:var(--font-size-section);line-height:var(--line-section);overflow-wrap:anywhere}
.modal-body{flex:1;min-height:0;overflow:auto;padding:var(--space-4) var(--space-5)}
.modal-foot{flex:none;display:flex;justify-content:flex-end;gap:var(--space-2);margin:0;padding:var(--space-3) var(--space-5);background:var(--color-surface);border-top:1px solid var(--color-border)}
.xbtn{width:var(--control-height);min-height:var(--control-height);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;background:transparent;border:1px solid transparent;color:var(--color-text-secondary);font-size:var(--font-size-section);padding:0;border-radius:var(--radius-md)}
.xbtn:hover{color:var(--color-text);background:var(--color-surface-hover);border-color:var(--color-border)}
.xbtn:focus-visible{outline:3px solid var(--color-accent-soft);outline-offset:2px;border-color:var(--color-accent)}
.xbtn:active{background:var(--color-border)}
.xbtn:disabled{cursor:not-allowed;color:var(--color-text-muted);background:var(--color-surface-muted)}
.frow{min-width:0;margin:var(--space-3) 0}
.frow > label{display:block;font-size:var(--font-size-metadata);line-height:var(--line-metadata);font-weight:650;color:var(--color-text-secondary);margin-bottom:var(--space-1);text-transform:uppercase;letter-spacing:.06em}
.frow input,.frow select,.frow textarea{width:100%;min-width:0;min-height:var(--control-height);background:var(--color-surface);color:var(--color-text);border:1px solid var(--color-border-strong);border-radius:var(--radius-md);padding:var(--space-2) var(--space-3);font-size:var(--font-size-body);line-height:var(--line-body);box-shadow:var(--shadow-control);transition:background-color 180ms cubic-bezier(.16,1,.3,1),border-color 180ms cubic-bezier(.16,1,.3,1),box-shadow 180ms cubic-bezier(.16,1,.3,1)}
.frow input:hover,.frow select:hover,.frow textarea:hover{border-color:var(--color-accent)}
.frow input:focus-visible,.frow select:focus-visible,.frow textarea:focus-visible{outline:3px solid var(--color-accent-soft);outline-offset:2px;border-color:var(--color-accent);box-shadow:none}
.frow input[aria-invalid="true"]{border-color:var(--color-error);background:var(--color-error-soft)}
.frow input:disabled,.frow select:disabled,.frow textarea:disabled{cursor:not-allowed;color:var(--color-text-muted);background:var(--color-surface-muted);border-color:var(--color-border);box-shadow:none}
.frow input.mono{font-family:var(--font-mono);font-size:var(--font-size-metadata)}
.frow input[readonly]{color:var(--color-text-secondary);background:var(--color-surface-muted);border-color:var(--color-border);box-shadow:none}
.frow textarea{resize:vertical;font-family:var(--font-mono);font-size:var(--font-size-metadata);line-height:var(--line-metadata)}
.fhint{font-size:var(--font-size-metadata);line-height:var(--line-metadata);color:var(--color-text-secondary);margin-top:var(--space-1);max-width:var(--prose-width);overflow-wrap:anywhere}
label.ck{min-height:var(--control-height);display:flex;align-items:center;gap:var(--space-2);font-size:var(--font-size-body);line-height:var(--line-body);cursor:pointer;text-transform:none;color:var(--color-text)}
label.ck input{width:1rem;height:1rem;min-height:0;flex:none;accent-color:var(--color-accent)}
.form-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 var(--space-4)}
.form-span{grid-column:1/-1}
.combo{position:relative;min-width:0}
.listbox{position:absolute;z-index:6;top:calc(100% + var(--space-1));left:0;right:0;max-height:min(17.5rem,calc(100dvh - 14rem));overflow:auto;padding:var(--space-1);background:var(--color-surface);border:1px solid var(--color-border-strong);border-radius:var(--radius-md);box-shadow:0 1rem 2.5rem oklch(.22 .02 255 / .18)}
.listbox[hidden]{display:none}
.list-group{padding:var(--space-1) 0 var(--space-2)}
.list-group + .list-group{border-top:1px solid var(--color-border)}
.list-group-title{padding:var(--space-1) var(--space-2);color:var(--color-text-muted);font-size:var(--font-size-metadata);line-height:var(--line-metadata);font-weight:650;text-transform:uppercase;letter-spacing:.06em}
.list-option{min-height:var(--control-height);display:flex;align-items:flex-start;gap:var(--space-2);width:100%;padding:var(--space-2);border:1px solid transparent;border-radius:var(--radius-sm);color:var(--color-text);background:transparent;text-align:left;cursor:pointer;font-size:var(--font-size-body);line-height:var(--line-body);transition:background-color 160ms cubic-bezier(.16,1,.3,1),border-color 160ms cubic-bezier(.16,1,.3,1),color 160ms cubic-bezier(.16,1,.3,1)}
.list-option:hover,.list-option.active{background:var(--color-surface-hover);border-color:var(--color-border-strong)}
.list-option:focus-visible{outline:3px solid var(--color-accent-soft);outline-offset:1px;border-color:var(--color-accent)}
.list-option:active{background:var(--color-border)}
.list-option[aria-selected="true"]{border-color:var(--color-accent);background:var(--color-accent-soft)}
.list-option[aria-disabled="true"]{color:var(--color-text-muted);background:var(--color-surface-muted);border-color:var(--color-border);cursor:not-allowed}
.list-option-main{min-width:0;flex:1}
.list-option-name{display:block;font-weight:600;overflow-wrap:anywhere}
.list-option-id{display:block;color:var(--color-text-secondary);font:var(--font-size-metadata)/var(--line-metadata) var(--font-mono);overflow-wrap:anywhere}
.compat{display:flex;align-items:flex-start;gap:var(--space-3);padding:var(--space-3);border:1px solid var(--color-border-strong);border-radius:var(--radius-md);background:var(--color-surface-muted)}
.compat strong{display:block;font-size:var(--font-size-body);line-height:var(--line-body)}.compat p{max-width:var(--prose-width);margin:var(--space-1) 0 0;color:var(--color-text-secondary);font-size:var(--font-size-metadata);line-height:var(--line-metadata)}
.compat.supported{border-color:var(--color-success);background:var(--color-success-soft)}.compat.beta,.compat.limited{border-color:var(--color-warning);background:var(--color-warning-soft)}
.compat.unsupported{border-color:var(--color-error);background:var(--color-error-soft)}
.compat-icon{font-weight:800;min-width:1rem}.compat.supported .compat-icon{color:var(--color-success)}
.compat.beta .compat-icon,.compat.limited .compat-icon{color:var(--color-warning)}.compat.unsupported .compat-icon{color:var(--color-error)}
.compat-action{margin:var(--space-2) 0 0}
.field-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 var(--space-4)}
.discovery-line{display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap;margin-top:var(--space-2)}
.discovery-status{flex:1;min-width:0;margin:0;padding:var(--space-2) var(--space-3);border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-surface-muted);overflow-wrap:anywhere}
.discovery-status.valid{color:var(--color-success);border-color:var(--color-success);background:var(--color-success-soft)}
.discovery-status.loading,.discovery-status.unverified,.discovery-status.rate_limited,.discovery-status.forbidden{color:var(--color-warning);border-color:var(--color-warning);background:var(--color-warning-soft)}
.discovery-status.invalid,.discovery-status.unsupported,.discovery-status.unreachable{color:var(--color-error);border-color:var(--color-error);background:var(--color-error-soft)}
.selected-models{display:flex;flex-wrap:wrap;gap:var(--space-2);min-height:var(--control-height);margin:var(--space-2) 0}
.selected-model{display:inline-flex;align-items:center;gap:var(--space-1);max-width:100%;padding:var(--space-1) var(--space-1) var(--space-1) var(--space-2);border:1px solid var(--color-accent);border-radius:var(--radius-full);background:var(--color-accent-soft);color:var(--color-accent-hover);font:var(--font-size-metadata)/var(--line-metadata) var(--font-mono)}
.selected-model span{min-width:0;overflow:hidden;text-overflow:ellipsis}.selected-remove{width:1.75rem;height:1.75rem;border:0;background:transparent;color:inherit;cursor:pointer;border-radius:50%;line-height:1;padding:0}
.selected-remove:hover{background:var(--color-surface)}
.selected-remove:focus-visible{outline:3px solid var(--color-accent-soft);outline-offset:1px;box-shadow:0 0 0 1px var(--color-accent)}
.selected-remove:active{background:var(--color-border)}
.selected-remove:disabled{cursor:not-allowed;color:var(--color-text-muted)}
.model-listbox{position:relative;top:auto;margin-top:var(--space-2);max-height:min(20.625rem,calc(100dvh - 16rem))}
.model-option{align-items:center}.model-option input{width:auto;min-height:0;flex:none;margin-top:var(--space-1);accent-color:var(--color-accent)}
.model-caps{display:flex;flex-wrap:wrap;gap:var(--space-1);margin-top:var(--space-1)}
.cap{font-size:var(--font-size-metadata);line-height:var(--line-metadata);padding:0 var(--space-2);border:1px solid var(--color-border-strong);border-radius:var(--radius-full);color:var(--color-text-secondary);white-space:nowrap}
.cap.true{color:var(--color-success);border-color:var(--color-success)}.cap.false{color:var(--color-text-muted)}.cap.unknown{color:var(--color-warning);border-color:var(--color-warning)}
.cap.source{color:var(--color-accent-hover);border-color:var(--color-accent)}
.manual-row{display:flex;gap:var(--space-2);min-width:0}.manual-row input{flex:1}.manual-row .btn{flex:none}
.empty-inline{padding:var(--space-3);color:var(--color-text-secondary);font-size:var(--font-size-metadata);line-height:var(--line-metadata);text-align:center}

#toast{position:fixed;left:50%;bottom:var(--space-5);transform:translateX(-50%) translateY(1.25rem);opacity:0;pointer-events:none;background:var(--color-text);border:1px solid var(--color-text);color:var(--color-surface);padding:var(--space-2) var(--space-4);border-radius:var(--radius-md);font-size:var(--font-size-body);line-height:var(--line-body);transition:opacity 180ms cubic-bezier(.16,1,.3,1),transform 180ms cubic-bezier(.16,1,.3,1);z-index:60;box-shadow:var(--shadow-dialog);max-width:min(82vw,40rem);overflow-wrap:anywhere}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
#toast.ok{border-color:var(--color-success)}
#toast.err{border-color:var(--color-error);color:var(--color-surface);background:var(--color-error)}

footer{max-width:var(--content-width);margin:0 auto;padding:0 var(--space-4) var(--space-6);color:var(--color-text-secondary);font-size:var(--font-size-metadata);line-height:var(--line-metadata);display:flex;gap:var(--space-5);justify-content:center;flex-wrap:wrap}
@media(max-width:860px){
  .topbar-inner{grid-template-columns:minmax(0,1fr) auto}
  .tabs{grid-column:1/-1;grid-row:2;width:100%;justify-content:center}
  .chips{justify-content:flex-end}
  #backupList ul{columns:1}
  .form-grid,.field-grid{grid-template-columns:1fr}
  .form-span{grid-column:auto}
}
@media(max-width:520px){
  .topbar{position:relative}
  .topbar-inner{grid-template-columns:minmax(0,1fr);gap:var(--space-3);padding:var(--space-3)}
  .brand{grid-row:1}
  .tabs{grid-column:1;grid-row:2}
  .tabbtn{flex:1;padding:0 var(--space-2)}
  .chips{grid-row:3;justify-content:flex-start}
  main{padding:0 var(--space-3);margin:var(--space-5) auto var(--space-6)}
  .pane-head{align-items:stretch}
  .pane-actions{width:100%}
  .pane-actions .btn{flex:1}
  .provider-summary{padding:var(--space-3)}
  .pcard{grid-template-columns:minmax(0,1fr);padding:var(--space-4) var(--space-3)}
  .pcard-actions{grid-column:1;grid-row:auto;align-self:auto;justify-content:flex-start;padding-top:var(--space-2);border-top:1px solid var(--color-border);flex-wrap:wrap}
  .pcard-actions .btn{flex:1}
  .pcard-row{align-items:flex-start}
  .pcard-row .lbl{width:3.5rem}
  .hrow{align-items:flex-start;flex-direction:column}
  .hrow .btn{align-self:stretch}
  .settings-section{padding:var(--space-4)}
  #modalWrap{padding:0;align-items:stretch;overflow:hidden}
  #modal{width:100%;height:100dvh;max-height:100dvh;border:0;border-radius:0}
  .modal-head{padding:var(--space-3);padding-top:calc(var(--space-3) + env(safe-area-inset-top))}
  .modal-body{padding:var(--space-3)}
  .modal-foot{padding:var(--space-3);padding-bottom:calc(var(--space-3) + env(safe-area-inset-bottom))}
  .modal-foot .btn{flex:1}
  .listbox{position:relative;top:auto;left:auto;right:auto;max-height:calc(100dvh - 16rem);margin-top:var(--space-2);box-shadow:none}
  .btn,.tabbtn,.xbtn,.list-option{min-height:var(--control-height-touch)}
  .btn.small{min-height:var(--control-height-touch)}
  .switch{min-width:var(--control-height-touch);min-height:var(--control-height-touch)}
  .switch .slider{top:.5rem;bottom:.5rem}
  label.ck{min-height:var(--control-height-touch)}
  .selected-remove{width:var(--control-height-touch);height:var(--control-height-touch)}
  .frow input,.frow select{min-height:var(--control-height-touch)}
  .manual-row{flex-direction:column}.manual-row .btn{align-self:stretch}
  #toast{bottom:var(--space-3);max-width:calc(100vw - 1.5rem);width:max-content}
}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
.upd-bar{display:inline-block;width:9.375rem;height:.5rem;border-radius:var(--radius-full);background:var(--color-border);overflow:hidden;vertical-align:middle;margin-left:var(--space-2)}
.upd-fill{display:block;height:100%;width:100%;background:var(--color-success);transform:scaleX(0);transform-origin:left center;transition:transform 220ms cubic-bezier(.16,1,.3,1)}
.chip.warn{color:var(--color-warning);border-color:var(--color-warning);background:var(--color-warning-soft)}
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <div class="brand">
      <svg class="logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4.5" cy="12" r="1.9" fill="currentColor" stroke="none"/><path d="M6.5 12h4"/><path d="M10.5 12c3.2 0 3.6-4.5 6.8-4.5"/><path d="M10.5 12c3.2 0 3.6 4.5 6.8 4.5"/><path d="M17.3 4.6 21 7.5l-3.7 2.9"/><path d="M17.3 13.6 21 16.5l-3.7 2.9"/></svg>
      <span class="brand-copy"><span class="brand-name">codex-switch</span><span class="sub">多供应商模型路由</span></span>
    </div>
    <nav class="tabs" role="tablist" aria-label="管理页面">
      <button id="tabbtn-providers" class="tabbtn active" role="tab" aria-selected="true" aria-controls="tab-providers" tabindex="0" onclick="switchTab('providers')">供应商</button>
      <button id="tabbtn-history" class="tabbtn" role="tab" aria-selected="false" aria-controls="tab-history" tabindex="-1" onclick="switchTab('history')">配置历史</button>
    </nav>
    <div class="chips" aria-label="运行状态">
      <span class="chip runtime-chip"><span class="dot on"></span>运行中</span>
      <span class="chip">${escapeHtml(host)}:${escapeHtml(port)}</span>
      <span class="chip" title="当前版本">v${escapeHtml(version)}</span>
      <span id="updArea"></span>
    </div>
  </div>
</header>
<main>

  <section id="tab-providers" class="pane" role="tabpanel" aria-labelledby="tabbtn-providers">
    <div class="pane-head">
      <div>
        <h2>供应商</h2>
      </div>
      <div class="pane-actions">
        <button class="btn" onclick="refreshCaps()">刷新模型能力</button>
        <button class="btn primary" onclick="openAdd()">＋ 添加供应商</button>
      </div>
    </div>
    <div class="provider-summary" aria-label="当前路由摘要">
      <div id="unionBar" class="union-bar muted">加载中…</div>
      <div id="unionChips" class="union-chips"><span class="hint">加载中…</span></div>
    </div>
    <div id="providerGrid" class="provider-list" role="list"></div>
    <p class="note">Codex 看到的模型 = 所有「启用」供应商的模型并集。停用供应商不会删除它,只是从路由表和并集中移除。API Key 在供应商「编辑」里直接填写(存本机 <span class="mono">~/.codex-switch/env</span>,chmod 600,保存即生效);供应商配置文件里只存环境变量名,不出现明文。</p>
  </section>

  <section id="tab-history" class="pane" role="tabpanel" aria-labelledby="tabbtn-history" style="display:none">
    <div class="pane-head">
      <div>
        <h2>配置历史</h2>
        <div class="union-bar muted" id="histCount"></div>
      </div>
      <div class="pane-actions"><button class="btn" onclick="loadHistory()">刷新</button></div>
    </div>
    <p class="note">每次在页面上改动供应商配置之前,都会自动把 <span class="mono">config.toml</span> 备份到这里。点「还原」会先把当前配置备份一份,再用所选版本覆盖,然后热重载路由表。</p>
    <div id="historyList" class="history-list" role="list"></div>
    <section class="settings-section">
      <div class="card-head"><h2>Codex 注入配置</h2></div>
      <p class="note">「应用并备份」= 把当前路由写入 <code>~/.codex/</code>(model_provider / model_catalog_json + catalog 合并),改动前自动备份,官方自有内容一字节不动,写入后重启 Codex 生效。「一键还原」= 取最新备份覆盖回 <code>~/.codex/</code>,移除注入的配置段与 catalog 合并条目。</p>
      <div class="pane-actions"><button class="btn primary" onclick="applyCodex()">应用并备份</button><button class="btn danger" onclick="restoreCodex()">一键还原</button></div>
      <div id="codexStatus" class="status muted"></div>
      <div style="margin-top:var(--space-3);padding-top:var(--space-3);border-top:1px solid var(--color-border)">
        <label style="display:flex;gap:var(--space-2);align-items:center;cursor:pointer;font-size:var(--font-size-body)">
          <input type="checkbox" id="autostartChk" onchange="toggleAutostart()">
          <span>开机 / 登录时自动启动服务 <span class="muted">(macOS LaunchAgent,默认开启)</span></span>
        </label>
        <div id="autostartInfo" class="status muted"></div>
      </div>
    </section>
  </section>

</main>
<footer><span>零请求改写</span><span>只监听 127.0.0.1</span><span>纯配置驱动</span><span>MIT</span></footer>

<div id="modalWrap" style="display:none">
  <div id="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
    <div class="modal-head"><b id="modalTitle">添加供应商</b><button class="xbtn" type="button" aria-label="关闭供应商设置" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
    <details class="advdet" id="importWrap"><summary>从 JSON 导入(粘贴其他机器「复制」得到的配置)</summary>
      <div class="frow"><label for="f-import">配置 JSON</label><textarea id="f-import" rows="5" class="mono" placeholder="粘贴从其他机器「复制」得到的供应商 JSON(可含 api_key)" spellcheck="false"></textarea>
      <div class="fhint">导入只是填充表单、不会直接落盘,仍需点「保存」。含 api_key 的 JSON 请妥善保管、勿外传。</div>
      <button class="btn small" type="button" onclick="importJson()">解析并填充表单</button></div>
    </details>
    <div class="form-grid">
      <div class="frow form-span">
        <label for="providerSearch">1 · 选择厂商</label>
        <div class="combo">
          <input id="providerSearch" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="providerListbox" aria-activedescendant="" autocomplete="off" placeholder="搜索 OpenAI、百炼、Kimi、Custom…">
          <div id="providerListbox" class="listbox" role="listbox" aria-label="厂商列表" hidden></div>
        </div>
      </div>
      <div class="frow form-span">
        <label>2 · Responses 兼容性</label>
        <div id="providerCompatibility" class="compat unverified" aria-live="polite">
          <span class="compat-icon" aria-hidden="true">?</span><div><strong>尚未选择厂商</strong><p>先搜索并选择一个厂商，再配置连接。</p></div>
        </div>
        <button id="useOpenRouter" class="btn small compat-action" type="button" hidden>改用 OpenRouter</button>
      </div>
    </div>
    <div id="routableSetup" hidden>
      <div class="field-grid" id="connectionFields"></div>
      <div class="form-grid">
        <div class="frow">
          <label for="f-name">名称</label><input id="f-name" placeholder="供应商显示名称" autocomplete="off">
        </div>
        <div class="frow">
          <label for="f-baseurl">路由 URL</label><input id="f-baseurl" class="mono" placeholder="https://…" spellcheck="false" readonly aria-describedby="f-baseurl-hint">
          <div class="fhint" id="f-baseurl-hint">固定和派生 URL 只读，保存时服务端会再次权威计算；Custom 可直接编辑。</div>
        </div>
      </div>
      <div class="frow" id="f-apikey-wrap"><label for="f-apikey">3 · API Key</label>
        <input id="f-apikey" type="password" class="mono" placeholder="在此粘贴 API Key" autocomplete="new-password" spellcheck="false" aria-describedby="f-apikey-hint discoveryStatus">
        <div class="fhint" id="f-apikey-hint">Key 仅通过本机 POST 请求检测，保存到 ~/.codex-switch/env(chmod 600)；不回显、不进 URL、不写日志。</div>
        <label class="ck" id="f-apikey-del-wrap" style="display:none;margin-top:.4rem"><input type="checkbox" id="f-apikey-del"> 清除已保存的 Key(该供应商将不可用,直到重新填写)</label>
        <div class="discovery-line">
          <button class="btn small" id="detectProvider" type="button">立即检测</button>
          <div id="discoveryStatus" class="discovery-status unverified" role="status" aria-live="polite">? 未验证 · 输入 Key 停顿 700 ms 后自动检测，也可立即检测。</div>
        </div>
      </div>
      <div class="frow">
        <label for="modelSearch">4 · 搜索并选择模型</label>
        <div id="selectedModels" class="selected-models" aria-live="polite"><span class="hint">尚未选择模型</span></div>
        <div class="combo">
          <input id="modelSearch" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="modelListbox" aria-activedescendant="" autocomplete="off" placeholder="搜索模型 ID 或名称">
          <div id="modelListbox" class="listbox model-listbox" role="listbox" aria-label="模型列表" aria-multiselectable="true" hidden></div>
        </div>
        <div class="fhint">能力徽标使用 ✓ / × / ? 三态，并标注 API、静态、未知或手动来源。刷新不会静默删除已选模型。</div>
      </div>
      <div class="frow">
        <label for="manualModelId">手动添加模型 / Deployment ID</label>
        <div class="manual-row"><input id="manualModelId" class="mono" autocomplete="off" placeholder="例如 endpoint-abc123"><button class="btn small" id="addManualModel" type="button">添加</button></div>
      </div>
    </div>
    <div class="frow"><label class="ck"><input type="checkbox" id="f-enabled" checked> 启用该供应商</label></div>
    <details class="advdet"><summary>高级选项(ID / 认证方式 / 环境变量名,一般不用动)</summary>
      <div class="frow"><label for="f-id">ID</label><input id="f-id" class="mono" placeholder="留空 = 按名称自动生成" spellcheck="false"></div>
      <div class="frow"><label for="f-auth">认证方式</label>
        <select id="f-auth" onchange="authChanged()">
          <option value="bearer">bearer — API Key(最常用)</option>
          <option value="chatgpt_subscription">chatgpt_subscription — ChatGPT 订阅</option>
          <option value="chatgpt_oauth">chatgpt_oauth — ChatGPT OAuth</option>
          <option value="passthrough">passthrough — 透传客户端凭证</option>
        </select>
      </div>
      <div class="frow" id="f-tokenenv-wrap"><label for="f-tokenenv">Token 环境变量名</label>
        <input id="f-tokenenv" class="mono" placeholder="留空 = 使用厂商默认值或 <ID>_API_KEY" spellcheck="false">
        <div class="fhint">配置文件里只存这个变量名,不出现明文 Key。</div>
      </div>
    </details>
    <div id="formMsg" class="status" role="status" aria-live="polite"></div>
    </div>
    <div class="modal-foot">
      <button class="btn" type="button" onclick="closeModal()">取消</button>
      <button class="btn primary" type="button" id="saveBtn" onclick="saveProvider()">保存</button>
    </div>
  </div>
</div>
<div id="toast" role="status" aria-live="polite"></div>

<script>
${filterOptions.toString()}
${mergeSelectedModels.toString()}
${getProviderSaveProblem.toString()}
${deriveProviderBaseUrl.toString()}
${nextOptionIndex.toString()}
${combineCapability.toString()}
${discoveryStatusCopy.toString()}
${shouldCloseModalOnEscape.toString()}
${shouldConsumeComboboxEscape.toString()}
${clearSensitiveModalFields.toString()}
${markDiscoveredModels.toString()}
${resolveDiscoveryModelSource.toString()}
${isModelToggleAllowed.toString()}
var CURRENT={providers:[],union:{providers:0,total:0,models:[]},envKeys:[],officialSync:{modelCount:0,sources:[]}};
var EDITING=null;
var PRESETS=[];
var SELECTED_PRESET=null;
var SEARCH_ORIGIN_PRESET=null;
var PROVIDER_OPTIONS={};
var DISCOVERED_MODELS=[];
var SELECTED_MODELS=[];
var DISCOVERY_MODEL_SOURCE='unknown';
var MANUAL_MODEL_IDS=new Set();
var VALIDATION_STATUS='unverified';
var HAS_SAVED_KEY=false;
var SAVED_PROVIDER_TYPE='';
var SAVED_TOKEN_ENV='';
var PROVIDER_ACTIVE=-1;
var MODEL_ACTIVE=-1;
var DISCOVERY_TIMER=null;
var DISCOVERY_CONTROLLER=null;
var DISCOVERY_SEQUENCE=0;
var PREVIOUS_FOCUS=null;
var STATIC_UNVERIFIED={'volcengine-ark':1,'azure-openai':1,'cloudflare-workers-ai':1};
function $(id){return document.getElementById(id);}
var PRETTY_ACR={gpt:1,api:1,llm:1,url:1,ws:1};
function prettyName(s){return String(s==null?'':s).split('-').map(function(w){if(!w)return w;if(PRETTY_ACR[w.toLowerCase()])return w.toUpperCase();return w.charAt(0).toUpperCase()+w.slice(1);}).join(' ');}
function toast(msg,ok){var t=$('toast');t.textContent=msg;t.className='show '+(ok===false?'err':'ok');clearTimeout(t._h);t._h=setTimeout(function(){t.className='';},2800);}
function api(url,body){
  var opts=body===undefined?{method:'GET'}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)};
  return fetch(url,opts).then(function(r){
    return r.json().catch(function(){return {error:'invalid response'};}).then(function(j){
      if(!r.ok){throw new Error(j.error||('HTTP '+r.status));}
      return j;
    });
  });
}
function switchTab(name){
  var tabs=['providers','history'];
  for(var i=0;i<tabs.length;i++){
    var pane=$('tab-'+tabs[i]);var btn=$('tabbtn-'+tabs[i]);
    btn.setAttribute('aria-selected',tabs[i]===name?'true':'false');
    btn.tabIndex=tabs[i]===name?0:-1;
    if(tabs[i]===name){pane.style.display='flex';btn.className='tabbtn active';}
    else{pane.style.display='none';btn.className='tabbtn';}
  }
  if(name==='providers')loadProviders();
  if(name==='history')loadHistory();
}

/* ---------- 供应商 ---------- */
function loadProviders(){
  api('/__admin/providers').then(function(j){
    CURRENT.providers=j.providers||[];
    CURRENT.union=j.union||{providers:0,total:0,models:[]};
    CURRENT.officialSync=j.officialSync||{modelCount:0,sources:[]};
    CURRENT.envKeys=j.envKeys||[];
    renderUnion();renderCards();
  }).catch(function(e){toast('加载供应商失败: '+e.message,false);});
}
function loadPresets(){
  return api('/__admin/provider-presets').then(function(j){
    PRESETS=Array.isArray(j.presets)?j.presets:[];
    return PRESETS;
  }).catch(function(e){toast('加载厂商目录失败: '+e.message,false);throw e;});
}
function renderUnion(){
  var u=CURRENT.union;
  var summary=$('unionBar');
  clearNode(summary);
  summary.appendChild(document.createTextNode('已启用 '));
  summary.appendChild(element('b','',String(u.providers)));
  summary.appendChild(document.createTextNode(' / '+u.total+' 个供应商 · Codex 当前可见模型 '));
  summary.appendChild(element('b','',String(u.models.length)));
  summary.appendChild(document.createTextNode(' 个（并集）'));
  var chips=$('unionChips');
  clearNode(chips);
  if(!u.models.length){chips.appendChild(element('span','hint','没有启用的供应商或模型为空，Codex 将看不到任何模型。'));return;}
  u.models.forEach(function(model){
    var tag=element('span','mtag',prettyName(model));
    tag.title=model;
    chips.appendChild(tag);
  });
}
function envKeyConfigured(name){
  if(!name)return false;
  var eks=CURRENT.envKeys||[];
  for(var i=0;i<eks.length;i++){if(eks[i].name===name)return !!eks[i].configured;}
  return false;
}
/* ID/环境变量名自动推导:名称 → slug;slug → <SLUG>_API_KEY */
function autoId(name){
  var s=String(name||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
  return s||('p-'+Math.random().toString(36).slice(2,7));
}
function autoTokenEnv(id){
  return ((String(id||'').toUpperCase().replace(/[^A-Z0-9]+/g,'_'))||'PROVIDER')+'_API_KEY';
}
function renderCards(){
  var g=$('providerGrid');var ps=CURRENT.providers;
  clearNode(g);
  if(!ps.length){g.appendChild(element('div','empty','还没有供应商。点右上角「＋ 添加供应商」创建第一个。'));return;}
  ps.forEach(function(provider){g.appendChild(providerCard(provider));});
}
function providerCard(p){
  var on=p.enabled!==false;
  var card=element('article','pcard'+(on?'':' off'));
  card.setAttribute('role','listitem');
  var top=element('div','pcard-top');
  var identity=element('div','pcard-id');
  identity.appendChild(element('span','dot'+(on?' on':'')));
  identity.appendChild(element('b','',p.name||p.id));
  identity.appendChild(element('span','pid',p.id));
  top.appendChild(identity);
  var toggleLabel=element('label','switch');
  toggleLabel.title=on?'点击停用':'点击启用';
  var toggle=document.createElement('input');
  toggle.type='checkbox';toggle.checked=on;toggle.dataset.toggle='1';toggle.dataset.id=p.id;
  toggle.setAttribute('aria-label',(on?'停用 ':'启用 ')+(p.name||p.id));
  toggleLabel.appendChild(toggle);
  toggleLabel.appendChild(element('span','slider'));
  top.appendChild(toggleLabel);
  card.appendChild(top);
  var authRow=element('div','pcard-row');
  authRow.appendChild(element('span','lbl','认证'));
  authRow.appendChild(element('span','badge',p.auth));
  if(p.token_env){
    var configured=envKeyConfigured(p.token_env);
    authRow.appendChild(element('span',configured?'cred':'warn-text','env: '+p.token_env+(configured?' · 已配置 ✓':' · 未配置（点「编辑」填写 API Key）')));
  }else if(p.auth==='bearer')authRow.appendChild(element('span','warn-text','缺少凭证'));
  card.appendChild(authRow);
  var urlRow=element('div','pcard-row');
  urlRow.appendChild(element('span','lbl','地址'));
  urlRow.appendChild(element('span','url mono',p.base_url||'—'));
  card.appendChild(urlRow);
  var modelTitle=element('div','pcard-row');modelTitle.appendChild(element('span','lbl','模型'));card.appendChild(modelTitle);
  var modelContainer=element('div','pcard-models');
  var models=(p.models||[]).slice().sort(function(a,b){return b.localeCompare(a);});
  if(!models.length)modelContainer.appendChild(element('span','hint','未配置模型'));
  models.forEach(function(model){var tag=element('span','mtag',prettyName(model));tag.title=model;modelContainer.appendChild(tag);});
  if(p.auth==='chatgpt_subscription'&&CURRENT.officialSync&&CURRENT.officialSync.modelCount){
    modelContainer.appendChild(element('span','hint','… 另有官方内嵌目录 '+CURRENT.officialSync.modelCount+' 个模型自动同步（升级 Codex 自动更新）'));
  }
  card.appendChild(modelContainer);
  var actions=element('div','pcard-actions');
  [['copy','复制','复制为 JSON（含 API Key，勿外传）'],['edit','编辑',''],['del','删除','']].forEach(function(entry){
    var button=element('button','btn small'+(entry[0]==='del'?' danger':''),entry[1]);
    button.type='button';button.dataset.act=entry[0];button.dataset.id=p.id;if(entry[2])button.title=entry[2];actions.appendChild(button);
  });
  card.appendChild(actions);
  return card;
}
function copyText(s,doneMsg){
  function ok(){toast(doneMsg||'已复制到剪贴板');}
  function fb(){var ta=document.createElement('textarea');ta.value=s;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();var good=false;try{good=document.execCommand('copy');}catch(e){}document.body.removeChild(ta);if(good){ok();}else{toast('复制失败,请手动复制',false);}}
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(s).then(ok,fb);}else{fb();}
}
function copyProvider(id){
  api('/__admin/providers/export?id='+encodeURIComponent(id)).then(function(j){
    if(j.ok===false||!j.provider){toast('导出失败: '+(j.error||'unknown error'),false);return;}
    var p=j.provider;
    var o={id:p.id,name:p.name,provider_type:p.provider_type,provider_options:p.provider_options||{},auth:p.auth,base_url:p.base_url,token_env:p.token_env,models:p.models||[],enabled:p.enabled!==false};
    if(p.api_key)o.api_key=p.api_key;
    var includesKey=!!p.api_key;
    var serialized=JSON.stringify(o,null,2);
    o.api_key='';p.api_key='';
    copyText(serialized,'已复制 '+id+' 配置 JSON'+(includesKey?'(含 API Key,勿外传)':''));
  }).catch(function(e){toast('导出失败: '+e.message,false);});
}
function toggleP(id,on){
  api('/__admin/providers/toggle',{id:id,enabled:on}).then(function(){
    toast((on?'已启用: ':'已停用: ')+id);loadProviders();
  }).catch(function(e){toast('切换失败: '+e.message,false);loadProviders();});
}
function delP(id){
  if(!confirm('确认删除供应商 "'+id+'"?会先自动备份当前配置。'))return;
  api('/__admin/providers/delete',{id:id}).then(function(){
    toast('已删除: '+id);loadProviders();
  }).catch(function(e){toast('删除失败: '+e.message,false);});
}
function findPreset(id){
  for(var i=0;i<PRESETS.length;i++){if(PRESETS[i].id===id)return PRESETS[i];}
  return null;
}
function optionLabel(name){
  return {
    region:'Region / 区域',
    workspace_id:'Workspace ID（可选）',
    site:'接入点',
    resource_endpoint:'Azure Resource Endpoint',
    account_id:'Cloudflare Account ID',
    base_url:'NIM 服务 URL'
  }[name]||name;
}
function optionChoiceLabel(name,value){
  var labels={
    'site:cn':'中国站',
    'site:intl':'国际站',
    'region:cn-beijing':'中国（北京）',
    'region:ap-southeast-1':'国际（新加坡）',
    'region:us-east-1':'美国（弗吉尼亚）'
  };
  return labels[name+':'+value]||value;
}
function clearNode(node){while(node.firstChild)node.removeChild(node.firstChild);}
function element(tag,className,textValue){
  var node=document.createElement(tag);
  if(className)node.className=className;
  if(textValue!==undefined)node.textContent=textValue;
  return node;
}
function closeProviderList(){
  $('providerListbox').hidden=true;
  $('providerSearch').setAttribute('aria-expanded','false');
  $('providerSearch').setAttribute('aria-activedescendant','');
  PROVIDER_ACTIVE=-1;
}
function renderProviderOptions(){
  var query=$('providerSearch').value;
  var visible=filterOptions(PRESETS,query);
  var list=$('providerListbox');
  clearNode(list);
  var grouped=new Map();
  visible.forEach(function(preset){
    if(!grouped.has(preset.group))grouped.set(preset.group,[]);
    grouped.get(preset.group).push(preset);
  });
  var optionIndex=0;
  grouped.forEach(function(items,groupName){
    var group=element('div','list-group');
    group.setAttribute('role','group');
    group.setAttribute('aria-label',groupName);
    group.appendChild(element('div','list-group-title',groupName));
    items.forEach(function(preset){
      var button=element('button','list-option');
      button.type='button';
      button.tabIndex=-1;
      button.id='provider-option-'+optionIndex;
      button.setAttribute('role','option');
      button.setAttribute('aria-selected',SELECTED_PRESET&&SELECTED_PRESET.id===preset.id?'true':'false');
      button.dataset.presetId=preset.id;
      var main=element('span','list-option-main');
      main.appendChild(element('span','list-option-name',preset.name));
      main.appendChild(element('span','list-option-id',preset.id));
      button.appendChild(main);
      var state=element('span','badge '+(preset.compatibility==='supported'?'ok':preset.compatibility==='unsupported'?'err':'warn'));
      state.textContent={supported:'可直连',beta:'Beta',limited:'有限制',unsupported:'不可直连'}[preset.compatibility]||preset.compatibility;
      button.appendChild(state);
      button.addEventListener('mousedown',function(event){event.preventDefault();});
      button.addEventListener('click',function(){selectPreset(preset,null,true);});
      group.appendChild(button);
      optionIndex+=1;
    });
    list.appendChild(group);
  });
  if(!visible.length)list.appendChild(element('div','empty-inline','没有匹配的厂商'));
  PROVIDER_ACTIVE=Math.min(Math.max(PROVIDER_ACTIVE,-1),optionIndex-1);
  updateProviderActive();
  list.hidden=false;
  $('providerSearch').setAttribute('aria-expanded','true');
}
function updateProviderActive(){
  var options=$('providerListbox').querySelectorAll('[role="option"]');
  for(var i=0;i<options.length;i++)options[i].classList.toggle('active',i===PROVIDER_ACTIVE);
  var active=options[PROVIDER_ACTIVE];
  $('providerSearch').setAttribute('aria-activedescendant',active?active.id:'');
  if(active)active.scrollIntoView({block:'nearest'});
}
function moveProviderActive(delta){
  if($('providerListbox').hidden)renderProviderOptions();
  var options=$('providerListbox').querySelectorAll('[role="option"]');
  if(!options.length)return;
  PROVIDER_ACTIVE=nextOptionIndex(PROVIDER_ACTIVE,options.length,delta);
  updateProviderActive();
}
function compatibilityCopy(preset){
  return {
    supported:{icon:'✓',title:'支持 Responses 直连'},
    beta:{icon:'△',title:'Responses Beta'},
    limited:{icon:'△',title:'Responses 支持有限制'},
    unsupported:{icon:'✕',title:'暂不支持 Responses 直连'}
  }[preset.compatibility]||{icon:'?',title:'兼容性未知'};
}
function renderCompatibility(preset){
  var box=$('providerCompatibility');
  clearNode(box);
  box.className='compat '+preset.compatibility;
  var copy=compatibilityCopy(preset);
  box.appendChild(element('span','compat-icon',copy.icon));
  box.firstChild.setAttribute('aria-hidden','true');
  var body=element('div');
  body.appendChild(element('strong','',copy.title+' · '+preset.name));
  body.appendChild(element('p','',preset.compatibilityNote||'请在保存前验证连接与模型。'));
  box.appendChild(body);
  var alternative=$('useOpenRouter');
  alternative.hidden=preset.compatibility!=='unsupported';
  alternative.dataset.query=preset.id;
}
function deriveBaseUrl(){
  return deriveProviderBaseUrl(SELECTED_PRESET,PROVIDER_OPTIONS,$('f-baseurl').value.trim());
}
function updateBaseUrl(invalidate){
  if(!SELECTED_PRESET)return;
  if(SELECTED_PRESET.id==='custom'){
    PROVIDER_OPTIONS.base_url=$('f-baseurl').value.trim();
  }else{
    $('f-baseurl').value=deriveBaseUrl();
  }
  if(invalidate){
    invalidateDiscovery(true,'连接信息已变化，请重新检测。');
    scheduleDiscoveryIfReady();
  }
}
function renderConnectionFields(){
  var container=$('connectionFields');
  clearNode(container);
  if(!SELECTED_PRESET)return;
  (SELECTED_PRESET.options||[]).forEach(function(field){
    if(SELECTED_PRESET.id==='custom'&&field.name==='base_url')return;
    var row=element('div','frow');
    var id='provider-option-field-'+field.name.replace(/[^a-z0-9_-]/gi,'-');
    var label=element('label','',optionLabel(field.name));
    label.setAttribute('for',id);
    row.appendChild(label);
    var input;
    if(field.type==='select'){
      input=document.createElement('select');
      (field.choices||[]).forEach(function(choice){
        var option=document.createElement('option');
        option.value=choice;
        option.textContent=optionChoiceLabel(field.name,choice);
        input.appendChild(option);
      });
      input.value=PROVIDER_OPTIONS[field.name]===undefined?field.default:PROVIDER_OPTIONS[field.name];
      input.addEventListener('change',connectionOptionChanged);
    }else{
      input=document.createElement('input');
      input.type=field.type==='url'?'url':'text';
      input.value=PROVIDER_OPTIONS[field.name]===undefined?(field.default||''):PROVIDER_OPTIONS[field.name];
      input.autocomplete='off';
      input.spellcheck=false;
      input.addEventListener('input',connectionOptionChanged);
      if(field.name==='workspace_id')input.placeholder='留空使用公共端点';
      if(field.name==='resource_endpoint')input.placeholder='https://<resource>.openai.azure.com';
    }
    input.id=id;
    input.dataset.optionName=field.name;
    if(field.type==='url')input.className='mono';
    row.appendChild(input);
    container.appendChild(row);
  });
}
function connectionOptionChanged(event){
  PROVIDER_OPTIONS[event.target.dataset.optionName]=event.target.value;
  updateBaseUrl(true);
}
function initialOptions(preset,existing){
  var source=existing&&existing.provider_options&&typeof existing.provider_options==='object'?existing.provider_options:{};
  var options={};
  (preset.options||[]).forEach(function(field){
    if(Object.prototype.hasOwnProperty.call(source,field.name))options[field.name]=source[field.name];
    else options[field.name]=field.default;
  });
  if(preset.id==='custom'&&existing&&existing.base_url)options.base_url=existing.base_url;
  return options;
}
function selectPreset(preset,existing,userDriven){
  abortDiscovery();
  var previous=SELECTED_PRESET||SEARCH_ORIGIN_PRESET;
  var sameSelection=!!(previous&&previous.id===preset.id);
  SELECTED_PRESET=preset;
  SEARCH_ORIGIN_PRESET=null;
  if(existing||!sameSelection)PROVIDER_OPTIONS=initialOptions(preset,existing);
  $('providerSearch').value=preset.name;
  closeProviderList();
  renderCompatibility(preset);
  $('routableSetup').hidden=!preset.routable;
  if(userDriven&&!sameSelection){
    $('f-name').value=preset.name;
    $('f-auth').value=preset.auth||'bearer';
    $('f-tokenenv').value=preset.tokenEnv||'';
    HAS_SAVED_KEY=false;
    resetApiKeyFields(false);
    SELECTED_MODELS=[];DISCOVERED_MODELS=[];
    MANUAL_MODEL_IDS.clear();
  }else if(existing){
    $('f-name').value=existing.name||preset.name;
    $('f-auth').value=existing.auth||preset.auth||'bearer';
    $('f-tokenenv').value=existing.token_env||preset.tokenEnv||'';
  }
  $('f-baseurl').readOnly=preset.id!=='custom';
  if(preset.id==='custom')$('f-baseurl').value=(existing&&existing.base_url)||String(PROVIDER_OPTIONS.base_url||'');
  renderConnectionFields();
  updateBaseUrl(false);
  authChanged(false);
  invalidateDiscovery(true,'尚未验证 · 输入 Key 停顿 700 ms 后自动检测，也可立即检测。');
  renderSelectedModels();
  renderModelList();
  if(preset.routable&&(HAS_SAVED_KEY||STATIC_UNVERIFIED[preset.id]))scheduleDiscoveryIfReady();
}
function clearSelectedPresetForSearch(){
  if(!SELECTED_PRESET)return;
  SEARCH_ORIGIN_PRESET=SELECTED_PRESET;
  SELECTED_PRESET=null;
  $('routableSetup').hidden=true;
  var box=$('providerCompatibility');
  clearNode(box);
  box.className='compat unverified';
  box.appendChild(element('span','compat-icon','?'));
  var body=element('div');
  body.appendChild(element('strong','','请选择列表中的厂商'));
  body.appendChild(element('p','','输入用于搜索，需用方向键和 Enter 或鼠标确认选择。'));
  box.appendChild(body);
  $('useOpenRouter').hidden=true;
  abortDiscovery();
}
function authChanged(invalidate){
  var auth=$('f-auth').value;
  $('f-tokenenv-wrap').style.display=(auth==='bearer'||auth==='chatgpt_oauth')?'':'none';
  $('f-apikey-wrap').style.display=auth==='bearer'?'':'none';
  if(invalidate!==false){
    invalidateDiscovery(true,'认证方式已变化，请重新检测。');
    scheduleDiscoveryIfReady();
  }
}
function setMsg(message,ok){
  var output=$('formMsg');
  output.textContent=message||'';
  output.className='status'+(message?' '+(ok===false?'err':ok===true?'ok':'muted'):'');
}
function resetApiKeyFields(configured){
  $('f-apikey').value='';
  $('f-apikey-del').checked=false;
  $('f-apikey-del-wrap').style.display=configured?'':'none';
  $('f-apikey-hint').textContent=configured
    ?'当前已配置 ✓；留空继续使用，粘贴新值会覆盖。Key 不回传页面。'
    :'Key 仅通过本机 POST 请求检测，保存到 ~/.codex-switch/env(chmod 600)；不回显、不进 URL、不写日志。';
}
function setDiscoveryStatus(status,message){
  var known={loading:1,valid:1,invalid:1,forbidden:1,rate_limited:1,unreachable:1,unverified:1,unsupported:1};
  VALIDATION_STATUS=known[status]?status:'unverified';
  var copy=discoveryStatusCopy(VALIDATION_STATUS);
  var output=$('discoveryStatus');
  output.className='discovery-status '+VALIDATION_STATUS;
  output.textContent=copy.icon+' '+copy.label+(message?' · '+message:'');
}
function abortDiscovery(){
  clearTimeout(DISCOVERY_TIMER);
  DISCOVERY_TIMER=null;
  DISCOVERY_SEQUENCE+=1;
  if(DISCOVERY_CONTROLLER){DISCOVERY_CONTROLLER.abort();DISCOVERY_CONTROLLER=null;}
}
function invalidateDiscovery(keepSelected,message){
  abortDiscovery();
  DISCOVERED_MODELS=[];
  DISCOVERY_MODEL_SOURCE=resolveDiscoveryModelSource();
  if(keepSelected)SELECTED_MODELS=mergeSelectedModels(SELECTED_MODELS.map(function(model){return model.id;}),[]);
  else SELECTED_MODELS=[];
  MODEL_ACTIVE=-1;
  setDiscoveryStatus('unverified',message||'连接信息变化后需要重新检测。');
  renderSelectedModels();
  renderModelList();
}
function scheduleDiscoveryIfReady(){
  clearTimeout(DISCOVERY_TIMER);
  if(!SELECTED_PRESET||!SELECTED_PRESET.routable)return;
  var entered=$('f-apikey').value.trim();
  var canUseSaved=HAS_SAVED_KEY&&!$('f-apikey-del').checked;
  if($('f-auth').value==='bearer'&&!entered&&!canUseSaved&&!STATIC_UNVERIFIED[SELECTED_PRESET.id])return;
  DISCOVERY_TIMER=setTimeout(requestDiscovery,700);
}
function requestDiscovery(){
  clearTimeout(DISCOVERY_TIMER);
  DISCOVERY_TIMER=null;
  if(!SELECTED_PRESET||!SELECTED_PRESET.routable){
    setDiscoveryStatus('unsupported','该厂商不能保存为直连路由。');
    return;
  }
  updateBaseUrl(false);
  var baseUrl=$('f-baseurl').value.trim();
  if(!baseUrl){
    setDiscoveryStatus('unverified','请先补全连接字段或 URL。');
    return;
  }
  var enteredKey=$('f-apikey').value.trim();
  var canUseSaved=HAS_SAVED_KEY&&!$('f-apikey-del').checked;
  if($('f-auth').value==='bearer'&&!enteredKey&&!canUseSaved&&!STATIC_UNVERIFIED[SELECTED_PRESET.id]){
    setDiscoveryStatus('invalid','请填写 API Key，或编辑已有已配置 Key 的供应商。');
    return;
  }
  abortDiscovery();
  var sequence=DISCOVERY_SEQUENCE;
  var controller=new AbortController();
  DISCOVERY_CONTROLLER=controller;
  setDiscoveryStatus('loading','正在校验连接并拉取模型…');
  var payload={
    provider_type:SELECTED_PRESET.id,
    provider_options:Object.assign({},PROVIDER_OPTIONS),
    base_url:baseUrl
  };
  if(EDITING!==null)payload.provider_id=EDITING;
  if(enteredKey)payload.api_key=enteredKey;
  var requestBody=JSON.stringify(payload);
  payload.api_key='';
  enteredKey='';
  fetch('/__admin/provider-discover',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:requestBody,
    signal:controller.signal
  }).then(function(response){
    return response.json().catch(function(){return {error:'invalid response'};}).then(function(json){
      if(!response.ok)throw new Error(json.error||('HTTP '+response.status));
      return json;
    });
  }).then(function(result){
    if(sequence!==DISCOVERY_SEQUENCE||controller.signal.aborted)return;
    var validation=result.validation||{status:'unverified',message:'未返回验证状态。'};
    DISCOVERY_MODEL_SOURCE=resolveDiscoveryModelSource(result.modelSource);
    DISCOVERED_MODELS=markDiscoveredModels(
      result.models,
      DISCOVERY_MODEL_SOURCE,
      SELECTED_PRESET&&SELECTED_PRESET.requiresManualModel===true
    );
    DISCOVERED_MODELS.forEach(function(model){if(model.referenceOnly)MANUAL_MODEL_IDS.delete(model.id);});
    SELECTED_MODELS=mergeSelectedModels(SELECTED_MODELS.map(function(model){return model.id;}),DISCOVERED_MODELS);
    MODEL_ACTIVE=-1;
    var warnings=Array.isArray(result.warnings)&&result.warnings.length?' '+result.warnings.join(' '):'';
    setDiscoveryStatus(validation.status,validation.message+warnings);
    renderSelectedModels();
    renderModelList();
    if(DISCOVERED_MODELS.length){
      $('modelListbox').hidden=false;
      $('modelSearch').setAttribute('aria-expanded','true');
    }
  }).catch(function(error){
    if(error&&error.name==='AbortError')return;
    if(sequence!==DISCOVERY_SEQUENCE)return;
    DISCOVERED_MODELS=[];
    DISCOVERY_MODEL_SOURCE=resolveDiscoveryModelSource();
    SELECTED_MODELS=mergeSelectedModels(SELECTED_MODELS.map(function(model){return model.id;}),[]);
    setDiscoveryStatus('unreachable','检测请求失败；可重试，已选手动模型仍保留。');
    renderSelectedModels();
    renderModelList();
  }).finally(function(){
    requestBody='';
    if(DISCOVERY_CONTROLLER===controller)DISCOVERY_CONTROLLER=null;
  });
}
function modelById(id){
  for(var i=0;i<DISCOVERED_MODELS.length;i++){if(DISCOVERED_MODELS[i].id===id)return DISCOVERED_MODELS[i];}
  for(var j=0;j<SELECTED_MODELS.length;j++){if(SELECTED_MODELS[j].id===id)return SELECTED_MODELS[j];}
  return null;
}
function allModelOptions(){
  var seen=new Set();
  var output=[];
  DISCOVERED_MODELS.concat(SELECTED_MODELS).forEach(function(model){
    if(!model||!model.id||seen.has(model.id))return;
    seen.add(model.id);
    output.push(model);
  });
  return output;
}
function isSelectedModel(id){
  for(var i=0;i<SELECTED_MODELS.length;i++){if(SELECTED_MODELS[i].id===id)return true;}
  return false;
}
function triState(value){
  return value===true?'true':value===false?'false':'unknown';
}
function appendCapability(container,label,value){
  var state=triState(value);
  var prefix=state==='true'?'✓ ':state==='false'?'× ':'? ';
  container.appendChild(element('span','cap '+state,prefix+label));
}
function appendContextCapability(container,value){
  var known=Number.isFinite(Number(value))&&Number(value)>0;
  var label=known?'上下文 '+Number(value).toLocaleString():'上下文 ?';
  container.appendChild(element('span','cap '+(known?'true':'unknown'),label));
}
function appendSourceCapability(container,source){
  var names={api:'API',static:'静态',unknown:'未知',manual:'手动',reference:'参考'};
  container.appendChild(element('span','cap source','来源 '+(names[source]||'未知')));
}
function renderModelCapabilities(container,model){
  appendContextCapability(container,model.contextWindow);
  appendCapability(container,'图片',model.input&&model.input.image);
  appendCapability(container,'音频',combineCapability(model.input&&model.input.audio,model.output&&model.output.audio));
  appendCapability(container,'视频',combineCapability(model.input&&model.input.video,model.output&&model.output.video));
  appendCapability(container,'Reasoning',model.reasoning);
  appendCapability(container,'Tools',model.tools);
  appendCapability(container,'Responses',model.responses);
  appendSourceCapability(container,model.referenceOnly?'reference':model.source);
}
function renderSelectedModels(){
  var container=$('selectedModels');
  clearNode(container);
  if(!SELECTED_MODELS.length){
    container.appendChild(element('span','hint','尚未选择模型'));
    return;
  }
  SELECTED_MODELS.forEach(function(model){
    var chip=element('span','selected-model');
    chip.appendChild(element('span','',model.id));
    var remove=element('button','selected-remove','×');
    remove.type='button';
    remove.setAttribute('aria-label','移除模型 '+model.id);
    remove.addEventListener('click',function(){toggleModel(model.id,false);});
    chip.appendChild(remove);
    container.appendChild(chip);
  });
}
function renderModelList(){
  var list=$('modelListbox');
  clearNode(list);
  var models=filterOptions(allModelOptions(),$('modelSearch').value);
  if(!models.length){
    list.appendChild(element('div','empty-inline',DISCOVERED_MODELS.length?'没有匹配模型':'检测成功后会列出模型；也可以手动添加 ID。'));
    MODEL_ACTIVE=-1;
    $('modelSearch').setAttribute('aria-activedescendant','');
    return;
  }
  if(MODEL_ACTIVE>=models.length)MODEL_ACTIVE=models.length-1;
  models.forEach(function(model,index){
    var option=element('div','list-option model-option'+(index===MODEL_ACTIVE?' active':''));
    option.id='model-option-'+index;
    option.tabIndex=-1;
    option.setAttribute('role','option');
    var selected=isSelectedModel(model.id);
    var toggleAllowed=isModelToggleAllowed(model,selected);
    option.setAttribute('aria-selected',selected?'true':'false');
    option.setAttribute('aria-disabled',toggleAllowed?'false':'true');
    var checkbox=document.createElement('input');
    checkbox.type='checkbox';
    checkbox.tabIndex=-1;
    checkbox.checked=selected;
    checkbox.disabled=!toggleAllowed;
    checkbox.setAttribute('aria-hidden','true');
    option.appendChild(checkbox);
    var main=element('div','list-option-main');
    main.appendChild(element('span','list-option-name',model.name||model.id));
    main.appendChild(element('span','list-option-id',model.id));
    var caps=element('div','model-caps');
    if(model.referenceOnly)caps.appendChild(element('span','cap unknown','仅供参考 · 不可路由'));
    renderModelCapabilities(caps,model);
    main.appendChild(caps);
    option.appendChild(main);
    option.addEventListener('click',function(event){
      event.preventDefault();
      if(!toggleAllowed){
        setMsg(model.referenceOnly
          ?'这是底座参考模型，不能直接路由；请在下方手动输入 Endpoint / Deployment ID。'
          :'该模型明确不支持 Responses，不能新增为 Codex 路由。',false);
        return;
      }
      toggleModel(model.id);
    });
    list.appendChild(option);
  });
  var active=list.querySelector('.active');
  $('modelSearch').setAttribute('aria-activedescendant',active?active.id:'');
}
function toggleModel(id,force){
  var selected=isSelectedModel(id);
  var candidate=modelById(id)||{id:id,name:id,source:'manual'};
  if(!isModelToggleAllowed(candidate,selected)){
    setMsg(candidate.referenceOnly
      ?'这是底座参考模型，不能直接路由；请在下方手动输入 Endpoint / Deployment ID。'
      :'该模型明确不支持 Responses，不能新增为 Codex 路由。',false);
    return;
  }
  var shouldSelect=force===undefined?!selected:force;
  if(shouldSelect&&!selected){
    SELECTED_MODELS=SELECTED_MODELS.concat([candidate]);
  }else if(!shouldSelect&&selected){
    SELECTED_MODELS=SELECTED_MODELS.filter(function(model){return model.id!==id;});
    MANUAL_MODEL_IDS.delete(id);
  }
  SELECTED_MODELS=mergeSelectedModels(SELECTED_MODELS.map(function(model){return model.id;}),DISCOVERED_MODELS);
  renderSelectedModels();
  renderModelList();
}
function addManualModel(){
  var input=$('manualModelId');
  var id=input.value.trim();
  if(!id){setMsg('请输入模型或 Deployment ID。',false);input.focus();return;}
  if(id.length>512){setMsg('模型 ID 过长，请检查。',false);return;}
  var reference=DISCOVERED_MODELS.find(function(model){return model.id===id&&model.referenceOnly;});
  if(reference){setMsg('这是底座参考模型 ID，请输入控制台创建的 Endpoint / Deployment ID。',false);return;}
  MANUAL_MODEL_IDS.add(id);
  toggleModel(id,true);
  if(!isSelectedModel(id))MANUAL_MODEL_IDS.delete(id);
  input.value='';
  setMsg('已添加手动模型；发现刷新不会删除它。',true);
  $('modelSearch').focus();
}
function moveModelActive(delta){
  $('modelListbox').hidden=false;
  $('modelSearch').setAttribute('aria-expanded','true');
  renderModelList();
  var options=$('modelListbox').querySelectorAll('[role="option"]');
  if(!options.length)return;
  MODEL_ACTIVE=nextOptionIndex(MODEL_ACTIVE,options.length,delta);
  renderModelList();
  var active=$('modelListbox').querySelector('.active');
  if(active)active.scrollIntoView({block:'nearest'});
}
function showModal(){
  PREVIOUS_FOCUS=document.activeElement;
  $('modalWrap').style.display='flex';
  $('providerSearch').focus();
}
function resetModalState(){
  abortDiscovery();
  EDITING=null;
  SELECTED_PRESET=null;
  SEARCH_ORIGIN_PRESET=null;
  PROVIDER_OPTIONS={};
  DISCOVERED_MODELS=[];
  SELECTED_MODELS=[];
  DISCOVERY_MODEL_SOURCE='unknown';
  MANUAL_MODEL_IDS.clear();
  VALIDATION_STATUS='unverified';
  HAS_SAVED_KEY=false;
  SAVED_PROVIDER_TYPE='';
  SAVED_TOKEN_ENV='';
  $('f-id').value='';
  $('f-id').readOnly=false;
  $('f-name').value='';
  $('f-auth').value='bearer';
  $('f-baseurl').value='';
  $('f-baseurl').readOnly=true;
  $('f-tokenenv').value='';
  $('f-enabled').checked=true;
  $('f-import').value='';
  $('providerSearch').value='';
  $('modelSearch').value='';
  $('manualModelId').value='';
  $('modelListbox').hidden=true;
  $('modelSearch').setAttribute('aria-expanded','false');
  $('routableSetup').hidden=true;
  $('useOpenRouter').hidden=true;
  resetApiKeyFields(false);
  setDiscoveryStatus('unverified','输入 Key 停顿 700 ms 后自动检测，也可立即检测。');
  setMsg('');
  renderSelectedModels();
  renderModelList();
}
function openAdd(){
  if(!PRESETS.length){loadPresets().then(openAdd).catch(function(){});return;}
  resetModalState();
  $('modalTitle').textContent='添加供应商';
  var box=$('providerCompatibility');
  clearNode(box);
  box.className='compat unverified';
  box.appendChild(element('span','compat-icon','?'));
  var body=element('div');
  body.appendChild(element('strong','','尚未选择厂商'));
  body.appendChild(element('p','','先搜索并选择一个厂商，再配置连接。'));
  box.appendChild(body);
  showModal();
  renderProviderOptions();
}
function openEdit(id){
  if(!PRESETS.length){loadPresets().then(function(){openEdit(id);}).catch(function(){});return;}
  var provider=null;
  for(var i=0;i<CURRENT.providers.length;i++){if(CURRENT.providers[i].id===id){provider=CURRENT.providers[i];break;}}
  if(!provider){toast('未找到供应商: '+id,false);return;}
  resetModalState();
  EDITING=id;
  SAVED_PROVIDER_TYPE=provider.provider_type||'custom';
  SAVED_TOKEN_ENV=provider.token_env||'';
  HAS_SAVED_KEY=envKeyConfigured(provider.token_env);
  $('modalTitle').textContent='编辑供应商 · '+id;
  $('f-id').value=provider.id;
  $('f-id').readOnly=true;
  $('f-enabled').checked=provider.enabled!==false;
  resetApiKeyFields(HAS_SAVED_KEY);
  SELECTED_MODELS=mergeSelectedModels(provider.models||[],[]);
  MANUAL_MODEL_IDS=new Set(provider.models||[]);
  var preset=findPreset(provider.provider_type)||findPreset('custom');
  selectPreset(preset,provider,false);
  renderSelectedModels();
  renderModelList();
  showModal();
}
function closeModal(){
  abortDiscovery();
  clearSensitiveModalFields($('f-apikey'),$('f-import'));
  closeProviderList();
  $('modelListbox').hidden=true;
  $('modelSearch').setAttribute('aria-expanded','false');
  $('modalWrap').style.display='none';
  if(PREVIOUS_FOCUS&&PREVIOUS_FOCUS.focus)PREVIOUS_FOCUS.focus();
}
function importJson(){
  var raw=$('f-import').value.trim();
  if(!raw){setMsg('请先粘贴 JSON 内容',false);return;}
  var imported;
  try{imported=JSON.parse(raw);}catch(error){setMsg('JSON 解析失败: '+error.message,false);return;}
  raw='';
  $('f-import').value='';
  if(!imported||typeof imported!=='object'||Array.isArray(imported)){setMsg('JSON 顶层必须是对象（供应商配置）。',false);return;}
  if(!imported.name&&!imported.base_url&&!imported.id){setMsg('无法识别：JSON 中至少要有 name / base_url / id 之一。',false);return;}
  var preset=findPreset(String(imported.provider_type||''))||findPreset('custom');
  HAS_SAVED_KEY=false;
  selectPreset(preset,{
    name:imported.name||preset.name,
    auth:imported.auth||preset.auth,
    token_env:imported.token_env||preset.tokenEnv,
    base_url:imported.base_url||'',
    provider_options:imported.provider_options||{}
  },false);
  if(EDITING===null)$('f-id').value=imported.id?String(imported.id):'';
  if(typeof imported.enabled==='boolean')$('f-enabled').checked=imported.enabled;
  SELECTED_MODELS=mergeSelectedModels(Array.isArray(imported.models)?imported.models:String(imported.models||'').split(/[\\n,]+/).filter(Boolean),[]);
  MANUAL_MODEL_IDS=new Set(SELECTED_MODELS.map(function(model){return model.id;}));
  if(imported.api_key||imported.token)$('f-apikey').value=String(imported.api_key||imported.token);
  renderSelectedModels();
  renderModelList();
  setMsg('已填充表单，请检查兼容性并完成检测。',true);
  scheduleDiscoveryIfReady();
  imported.api_key='';
  imported.token='';
}
function allowUnverifiedSave(){
  return EDITING!==null||!!(SELECTED_PRESET&&(SELECTED_PRESET.id==='custom'||STATIC_UNVERIFIED[SELECTED_PRESET.id]));
}
function saveProvider(){
  var name=$('f-name').value.trim();
  if(!name){setMsg('名称不能为空。',false);$('f-name').focus();return;}
  if(!SELECTED_PRESET){setMsg('请先从列表选择厂商。',false);$('providerSearch').focus();return;}
  updateBaseUrl(false);
  var baseUrl=$('f-baseurl').value.trim();
  if(!baseUrl&&SELECTED_PRESET.routable){setMsg('请补全连接字段或 URL。',false);return;}
  var id=$('f-id').value.trim()||autoId(name);
  var tokenEnv=$('f-tokenenv').value.trim();
  var auth=$('f-auth').value;
  if(auth==='bearer'&&!tokenEnv)tokenEnv=SELECTED_PRESET.tokenEnv||autoTokenEnv(id);
  var enteredKey=$('f-apikey').value.trim();
  var deleteKey=$('f-apikey-del').checked;
  var modelIds=SELECTED_MODELS.map(function(model){return model.id;});
  var problem=getProviderSaveProblem({
    routable:!!SELECTED_PRESET.routable,
    compatibility:SELECTED_PRESET.compatibility,
    auth:auth,
    hasKey:!!enteredKey,
    hasSavedKey:HAS_SAVED_KEY&&!deleteKey,
    modelIds:modelIds,
    modelSource:DISCOVERY_MODEL_SOURCE,
    requiresManualModel:SELECTED_PRESET.requiresManualModel===true,
    manualModelIds:Array.from(MANUAL_MODEL_IDS),
    validationStatus:VALIDATION_STATUS,
    allowUnverified:allowUnverifiedSave()
  });
  if(problem){setMsg(problem,false);return;}
  var provider={
    id:id,
    name:name,
    provider_type:SELECTED_PRESET.id,
    provider_options:Object.assign({},PROVIDER_OPTIONS),
    auth:auth,
    base_url:baseUrl,
    models:modelIds,
    enabled:$('f-enabled').checked
  };
  if(SELECTED_PRESET.id==='custom')provider.provider_options.base_url=baseUrl;
  if(tokenEnv)provider.token_env=tokenEnv;
  var url='/__admin/providers';
  var body=provider;
  if(EDITING!==null){url='/__admin/providers/update';body={origId:EDITING,provider:provider};}
  var keyOperation=auth==='bearer'&&tokenEnv&&(enteredKey||deleteKey);
  var advisory=VALIDATION_STATUS!=='valid';
  $('saveBtn').disabled=true;
  $('saveBtn').setAttribute('aria-busy','true');
  api(url,body).then(function(){
    if(!keyOperation){
      $('saveBtn').disabled=false;
      $('saveBtn').setAttribute('aria-busy','false');
      enteredKey='';
      toast((EDITING!==null?'供应商已更新: ':'供应商已添加: ')+provider.id+(advisory?' · 连接未确认，首次调用为准':''));
      closeModal();
      loadProviders();
      return;
    }
    var operation=deleteKey&&!enteredKey
      ?api('/__admin/env-keys/delete',{name:tokenEnv})
      :api('/__admin/env-keys/save',{name:tokenEnv,value:enteredKey});
    operation.then(function(){
      $('saveBtn').disabled=false;
      $('saveBtn').setAttribute('aria-busy','false');
      var what=deleteKey&&!enteredKey?'Key 已清除':'API Key 已保存，立即生效';
      enteredKey='';
      toast((EDITING!==null?'供应商已更新: ':'供应商已添加: ')+provider.id+' · '+what+(advisory?' · 连接未确认':''));
      closeModal();
      loadProviders();
    },function(error){
      $('saveBtn').disabled=false;
      $('saveBtn').setAttribute('aria-busy','false');
      enteredKey='';
      setMsg('供应商已保存，但 API Key 操作失败: '+error.message,false);
      loadProviders();
    });
  },function(error){
    $('saveBtn').disabled=false;
    $('saveBtn').setAttribute('aria-busy','false');
    enteredKey='';
    setMsg(error.message,false);
  });
}
$('providerSearch').addEventListener('focus',renderProviderOptions);
$('providerSearch').addEventListener('input',function(){
  if(SELECTED_PRESET&&$('providerSearch').value!==SELECTED_PRESET.name)clearSelectedPresetForSearch();
  PROVIDER_ACTIVE=-1;
  renderProviderOptions();
});
$('providerSearch').addEventListener('keydown',function(event){
  if(event.key==='ArrowDown'){event.preventDefault();moveProviderActive(1);}
  else if(event.key==='ArrowUp'){event.preventDefault();moveProviderActive(-1);}
  else if(event.key==='Enter'){
    var options=$('providerListbox').querySelectorAll('[role="option"]');
    if(options[PROVIDER_ACTIVE]){event.preventDefault();options[PROVIDER_ACTIVE].click();}
  }else if(shouldConsumeComboboxEscape(event.key,!$('providerListbox').hidden)){
    event.preventDefault();closeProviderList();
  }
});
$('f-baseurl').addEventListener('input',function(){
  if(SELECTED_PRESET&&SELECTED_PRESET.id==='custom')updateBaseUrl(true);
});
$('f-apikey').addEventListener('input',function(){
  invalidateDiscovery(true,'Key 已变化，等待 700 ms 后检测。');
  scheduleDiscoveryIfReady();
});
$('f-apikey').addEventListener('blur',function(){
  clearTimeout(DISCOVERY_TIMER);
  if($('f-apikey').value.trim()||HAS_SAVED_KEY||SELECTED_PRESET&&STATIC_UNVERIFIED[SELECTED_PRESET.id])requestDiscovery();
});
$('f-apikey-del').addEventListener('change',function(){
  invalidateDiscovery(true,this.checked?'已选择清除 Key；取消或填写新 Key 后再检测。':'Key 状态已变化，请重新检测。');
  scheduleDiscoveryIfReady();
});
$('detectProvider').addEventListener('click',requestDiscovery);
$('addManualModel').addEventListener('click',addManualModel);
$('manualModelId').addEventListener('keydown',function(event){if(event.key==='Enter'){event.preventDefault();addManualModel();}});
$('modelSearch').addEventListener('focus',function(){
  $('modelListbox').hidden=false;
  $('modelSearch').setAttribute('aria-expanded','true');
  renderModelList();
});
$('modelSearch').addEventListener('input',function(){
  $('modelListbox').hidden=false;
  $('modelSearch').setAttribute('aria-expanded','true');
  MODEL_ACTIVE=-1;
  renderModelList();
});
$('modelSearch').addEventListener('keydown',function(event){
  if(event.key==='ArrowDown'){event.preventDefault();moveModelActive(1);}
  else if(event.key==='ArrowUp'){event.preventDefault();moveModelActive(-1);}
  else if(event.key==='Enter'||event.key===' '){
    var active=$('modelListbox').querySelector('.active');
    if(active){event.preventDefault();active.click();}
  }else if(shouldConsumeComboboxEscape(event.key,!$('modelListbox').hidden)){
    event.preventDefault();
    $('modelListbox').hidden=true;
    $('modelSearch').setAttribute('aria-expanded','false');
    $('modelSearch').setAttribute('aria-activedescendant','');
  }
});
$('useOpenRouter').addEventListener('click',function(){
  var query=this.dataset.query||'';
  var preset=findPreset('openrouter');
  if(!preset)return;
  selectPreset(preset,null,true);
  $('modelSearch').value=query;
  renderModelList();
  setMsg('已切换到 OpenRouter；填写 OpenRouter Key 后会搜索相关模型。',true);
  $('modelSearch').focus();
});
$('f-tokenenv').addEventListener('input',function(){
  HAS_SAVED_KEY=EDITING!==null&&SELECTED_PRESET&&SELECTED_PRESET.id===SAVED_PROVIDER_TYPE
    &&this.value.trim()===SAVED_TOKEN_ENV&&envKeyConfigured(SAVED_TOKEN_ENV);
  invalidateDiscovery(true,'凭证来源已变化，请重新检测。');
});
document.addEventListener('click',function(event){
  if(!event.target.closest('#providerSearch')&&!event.target.closest('#providerListbox'))closeProviderList();
  if(!event.target.closest('#modelSearch')&&!event.target.closest('#modelListbox')){
    $('modelListbox').hidden=true;
    $('modelSearch').setAttribute('aria-expanded','false');
    $('modelSearch').setAttribute('aria-activedescendant','');
  }
});
document.addEventListener('keydown',function(event){
  if(event.key==='Tab'&&$('modalWrap').style.display!=='none'){
    var focusable=Array.prototype.filter.call($('modal').querySelectorAll('button,input,select,textarea,[tabindex]'),function(node){
      return !node.disabled&&node.tabIndex>=0&&!node.hidden&&node.offsetParent!==null;
    });
    if(focusable.length){
      var first=focusable[0],last=focusable[focusable.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();return;}
      if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();return;}
    }
  }
  if(shouldCloseModalOnEscape({
    key:event.key,
    defaultPrevented:event.defaultPrevented,
    modalOpen:$('modalWrap').style.display!=='none',
    providerOpen:!$('providerListbox').hidden,
    modelOpen:!$('modelListbox').hidden
  }))closeModal();
});
$('providerGrid').addEventListener('click',function(e){
  var t=e.target.closest?e.target.closest('[data-act]'):null;
  if(!t)return;
  var id=t.getAttribute('data-id');
  if(t.getAttribute('data-act')==='copy')copyProvider(id);
  if(t.getAttribute('data-act')==='edit')openEdit(id);
  if(t.getAttribute('data-act')==='del')delP(id);
});
$('providerGrid').addEventListener('change',function(e){
  var t=e.target;
  if(t&&t.matches&&t.matches('[data-toggle]'))toggleP(t.getAttribute('data-id'),t.checked);
});
function refreshCaps(){
  toast('正在联网获取模型能力…');
  api('/__admin/fetch-capabilities',{}).then(function(){
    toast('模型能力刷新完成');loadProviders();
  }).catch(function(e){toast('刷新失败: '+e.message,false);});
}

/* ---------- 配置历史 ---------- */
function fmtTime(t){
  if(!t||t.length!==14)return t||'';
  return t.slice(0,4)+'-'+t.slice(4,6)+'-'+t.slice(6,8)+' '+t.slice(8,10)+':'+t.slice(10,12)+':'+t.slice(12,14);
}
function fmtSize(n){
  if(n==null)return '';
  if(n<1024)return n+' B';
  if(n<1048576)return (n/1024).toFixed(1)+' KB';
  return (n/1048576).toFixed(2)+' MB';
}
function loadHistory(){
  api('/__admin/history').then(function(j){
    var hs=j.history||[];
    $('histCount').textContent=hs.length?('共 '+hs.length+' 份备份,按时间倒序'):'';
    var el=$('historyList');
    clearNode(el);
    if(!hs.length){el.appendChild(element('div','empty','还没有配置备份。每次在页面上改动供应商配置，都会自动在这里生成一份。'));return;}
    hs.forEach(function(history){
      var row=element('article','hrow');
      row.setAttribute('role','listitem');
      var info=element('div','hinfo');
      info.appendChild(element('span','htime',fmtTime(history.time)));
      info.appendChild(element('span','hseq','#'+history.seq));
      info.appendChild(element('span','hsize',fmtSize(history.size)));
      info.appendChild(element('span','hfile mono',history.file));
      row.appendChild(info);
      var restore=element('button','btn small','还原');
      restore.type='button';restore.dataset.act='restore';restore.dataset.file=history.file;
      row.appendChild(restore);
      el.appendChild(row);
    });
  }).catch(function(e){toast('加载配置历史失败: '+e.message,false);});
}
function restoreHist(file){
  if(!confirm('确认还原到这份配置?\\n'+file+'\\n\\n会先把当前配置备份一份,再覆盖并热重载。'))return;
  api('/__admin/history/restore',{file:file}).then(function(j){
    toast('已还原: '+j.restored);loadProviders();loadHistory();
  }).catch(function(e){toast('还原失败: '+e.message,false);});
}
$('historyList').addEventListener('click',function(e){
  var t=e.target.closest?e.target.closest('[data-act]'):null;
  if(!t)return;
  if(t.getAttribute('data-act')==='restore')restoreHist(t.getAttribute('data-file'));
});

/* ---------- Codex 注入配置:一键还原(已并入「配置历史」页签) ---------- */
function setCodexStatus(cls,msg){var el=$('codexStatus');if(el){el.className='status '+cls;el.textContent=msg;}}
function applyCodex(){
  setCodexStatus('muted','正在写入 ~/.codex/(改动前自动备份)…');
  api('/__admin/codex-apply',{}).then(function(j){
    if(j.ok===false){setCodexStatus('err','✗ 应用失败: '+j.error+(j.detail?'('+j.detail+')':''));return;}
    var bk=(j.backups&&j.backups.length)?j.backups.map(function(x){return x.file+' → '+x.backup;}).join(', '):'(无可备份文件)';
    var pre=j.preserved||{};
    var sec=(pre.configSectionsAfter!=null)?(' · Codex 原有配置保留 '+pre.configSectionsAfter+' 段'):'';
    setCodexStatus('ok','✓ 已应用,备份: '+bk+sec+' — 重启 Codex 生效');
  }).catch(function(e){setCodexStatus('err','✗ 应用失败: '+e.message);});
}
function restoreCodex(){
  setCodexStatus('muted','正在还原注入前的官方配置…');
  api('/__admin/codex-restore',{}).then(function(j){
    var parts=(j.restored||[]).map(function(x){
      if(x.action==='unchanged')return x.file+'(无注入,未改动)';
      if(x.action==='stripped')return x.file+'(注入段已剥离,官方内容保留)';
      if(x.action==='removed')return x.file+'(已删除,注入前本不存在)';
      if(x.action==='filtered')return x.file+'('+x.from+')';
      if(x.action==='error')return x.file+'(处理失败: '+x.from+')';
      return x.file+(x.from?' ← '+x.from:'');
    });
    setCodexStatus('ok','✓ 已还原: '+(parts.length?parts.join(', '):'(无可还原内容)')+' — 重启 Codex 生效');
  }).catch(function(e){setCodexStatus('err','✗ 还原失败: '+e.message);});
}

/* ---------- 开机自动启动 (macOS LaunchAgent) ---------- */
function loadAutostart(){
  api('/__admin/autostart').then(function(j){
    var chk=$('autostartChk');var info=$('autostartInfo');
    if(!chk)return;
    if(!j.supported){chk.disabled=true;chk.checked=false;if(info)info.textContent='自动启动仅支持 macOS(LaunchAgent),当前系统不支持。';return;}
    chk.checked=!!j.enabled;
    if(info)info.textContent=j.enabled?('✓ 已启用 · '+j.plist+' → '+j.entry):('已关闭 · 勾选后写入 '+j.plist+',下次登录自动启动');
  }).catch(function(e){var info=$('autostartInfo');if(info)info.textContent='读取自动启动状态失败: '+e.message;});
}
function toggleAutostart(){
  var chk=$('autostartChk');if(!chk||chk.disabled)return;
  chk.disabled=true;
  api('/__admin/autostart',{enabled:chk.checked}).then(function(j){
    chk.disabled=false;chk.checked=!!j.enabled;
    toast(j.enabled?'开机自动启动已开启':'开机自动启动已关闭');
    loadAutostart();
  }).catch(function(e){chk.disabled=false;setMsg(e.message,false);loadAutostart();});
}

/* ---------- 检查更新 ---------- */
var UPD_POLL=null;
function initUpdate(){
  api('/__admin/update/check').then(function(j){
    if(j.ok===false)return;
    if(j.newer&&j.assetUrl){
      var a=$('updArea');
      if(a){
        clearNode(a);
        a.appendChild(element('span','chip warn','发现新版本 v'+j.latest));
        var button=element('button','btn small primary','更新');button.type='button';button.addEventListener('click',startUpdate);a.appendChild(button);
      }
    }
  }).catch(function(){});
}
function startUpdate(){
  var a=$('updArea');
  if(!a)return;
  clearNode(a);
  var bar=element('span','upd-bar');
  var fill=element('span','upd-fill');fill.id='updFill';bar.appendChild(fill);a.appendChild(bar);
  var text=element('span','muted','准备中…');text.id='updText';text.style.marginLeft='.4rem';a.appendChild(text);
  api('/__admin/update/run',{}).then(function(j){
    if(j.ok===false){updFail(j.error||'启动更新失败');return;}
    pollUpdate();
  }).catch(function(e){updFail(e.message);});
}
function pollUpdate(){
  clearTimeout(UPD_POLL);
  api('/__admin/update/status').then(function(j){
    var st=j.state||{};
    var fill=$('updFill'),txt=$('updText');
    if(!fill||!txt)return;
    if(st.phase==='downloading'){
      if(st.total>0){var pct=Math.min(99,Math.floor(st.downloaded/st.total*100));fill.style.transform='scaleX('+(pct/100)+')';txt.textContent='下载中 '+pct+'%('+fmtSize(st.downloaded)+'/'+fmtSize(st.total)+')';}
      else{txt.textContent=st.detail||'正在获取更新包…';}
      UPD_POLL=setTimeout(pollUpdate,700);
    }else if(st.phase==='installing'){
      fill.style.transform='scaleX(1)';txt.textContent=st.detail||'正在安装…';
      UPD_POLL=setTimeout(pollUpdate,700);
    }else if(st.phase==='done'){
      fill.style.transform='scaleX(1)';txt.textContent=st.detail||'更新完成,正在重启…';
      if(j.mode==='source'){txt.textContent=(st.detail||'更新完成')+'(页面即将自动刷新)';setTimeout(function(){location.reload();},6000);}
    }else if(st.phase==='error'){
      updFail(st.detail||'更新失败');
    }else{
      if(st.detail)txt.textContent=st.detail;
      UPD_POLL=setTimeout(pollUpdate,700);
    }
  }).catch(function(e){updFail(e.message);});
}
function updFail(msg){
  var a=$('updArea');
  if(a){
    clearNode(a);
    var warning=element('span','chip warn','更新失败');warning.title=msg;a.appendChild(warning);
    var retry=element('button','btn small','重试');retry.type='button';retry.addEventListener('click',initUpdate);a.appendChild(retry);
  }
  toast('更新失败: '+msg,false);
}

loadProviders();
loadPresets().catch(function(){});
loadAutostart();
initUpdate();
</script>
</body></html>`;
}
