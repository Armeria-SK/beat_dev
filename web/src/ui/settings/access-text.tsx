import type { ReactNode } from 'react';
import type { useT } from '../../i18n/index.ts';
import { POLICY_LABEL } from '../../skills-meta.ts';
import type { Access } from '../../settings/access.ts';

type Translate = ReturnType<typeof useT>;

const broadNote = (t: Translate, broad: 'filesystem' | 'home' | null): ReactNode => (broad ? <span className="sk-warn">{t(broad === 'filesystem' ? 'folders.confirm.filesystem' : 'folders.confirm.home')}</span> : null);

export function accessText(t: Translate, a: Access): ReactNode {
  const stage = (s: 'preToolUse' | 'postToolUse') => t(s === 'preToolUse' ? 'settings.tools.hookPre' : 'settings.tools.hookPost');
  const hook = (h: { matcher: string; command: string[] }) => `${h.matcher} → ${h.command.join(' ') || '—'}`;
  switch (a.kind) {
    case 'deny-removed': return <>{t('folders.confirm.denyRemoved', a.path)}{a.builtin && <span className="sk-warn">{t('folders.confirm.denyBuiltin')}</span>}</>;
    case 'root-added': return <>{t('folders.confirm.rootAdded', a.path, t(a.mode === 'write' ? 'folders.mode.write' : 'folders.mode.read'))}{broadNote(t, a.broad)}</>;
    case 'root-write': return <>{t('folders.confirm.rootWrite', a.path)}{broadNote(t, a.broad)}</>;
    case 'shell-enabled': return t('access.shellEnabled');
    case 'shell-allow-added': return <>{t('access.shellAllow', a.command)}{a.runsCode && <span className="sk-warn">{t('access.shellAllowCode')}</span>}</>;
    case 'shell-ask-removed': return t('access.shellAsk', a.command);
    case 'shell-deny-removed': return t('access.shellDeny', a.command);
    case 'shell-env-added': return t('access.shellEnv', a.name);
    case 'outside-loosened': return t('access.outside');
    case 'web-fetch-on': return t('access.webFetch');
    case 'web-search-on': return t('access.webSearch');
    case 'self-tasks-unapproved': return t('access.selfTasks');
    case 'skills-auto-register': return t('access.skillsAutoRegister');
    case 'judge-off': return <>{t('access.judgeOff')}<span className="sk-warn">{t('access.judgeOffTaint')}</span><span className="sk-warn">{t('access.judgeOffSnapshot')}</span><span className="ui-set__still">{t('access.judgeOffStill')}</span></>;
    case 'hook-added': return t('access.hookAdded', stage(a.stage), hook(a.hook));
    case 'hook-edited': return t('access.hookEdited', stage(a.stage), hook(a.hook));
    case 'hook-removed': return t('access.hookRemoved', stage(a.stage), hook(a.hook));
    case 'hook-disabled': return t('access.hookDisabled', stage(a.stage), hook(a.hook));
    case 'origin-added': return t('access.origin', a.origin);
    case 'login-added': return t('access.login', a.login);
    case 'logins-cleared': return t('access.loginsCleared');
    case 'host-exposed': return t('access.host', a.host);
    case 'provider-url': return t('access.providerUrl', a.id, a.url);
    case 'provider-key': return t('access.providerKey', a.id, a.env);
    case 'provider-key-send': return t('access.providerKeySend', a.id, a.url);
    case 'notify-channel-added': return t('access.notifyAdded', a.id);
    case 'notify-channel-target': return t('access.notifyTarget', a.id);
    case 'notify-channel-body': return t('access.notifyBody', a.id);
    case 'notify-channel-kinds': return t('access.notifyKinds', a.id, a.kinds.map(k => t(`notifications.kind.${k as 'info'}`)).join(', '));
    case 'notify-channel-enabled': return t('access.notifyEnabled', a.id);
    case 'notify-public-url': return t('access.notifyPublicUrl', a.url);
    case 'mcp-server-added': return t('access.mcpAdded', a.id, a.target);
    case 'mcp-server-target': return t('access.mcpTarget', a.id, a.target);
    case 'mcp-server-env': return t('access.mcpEnv', a.id, a.names.join(', '));
    case 'mcp-server-secret': return t('access.mcpSecret', a.id, a.name);
    case 'mcp-server-enabled': return t('access.mcpEnabled', a.id);
    case 'mcp-tool-added': return t('access.mcpToolAdded', a.id, a.tool);
    case 'mcp-tool-enabled': return t('access.mcpToolEnabled', a.id, a.tool);
    case 'mcp-tool-loosened': return t('access.mcpToolLoosened', a.id, a.tool);
    case 'limit-raised': return t('access.limitRaised', a.key, a.from, a.to);
    case 'browser-enabled': return t('access.browserEnabled');
    case 'browser-site-added': return t('access.browserSiteAdded', a.site);
    case 'browser-site-widened': return t('access.browserSiteWidened', a.site);
    case 'browser-executable': return t('access.browserExecutable');
    case 'tool-policy-loosened': return t('access.toolPolicy', a.tool, t(POLICY_LABEL[a.from]), t(POLICY_LABEL[a.to]));
  }
}
