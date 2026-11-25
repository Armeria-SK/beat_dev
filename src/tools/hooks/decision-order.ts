export type Order = 1 | 3 | 4 | 5;

const REFUSED = [
  'guard.empty', 'guard.fork_bomb', 'guard.elevate', 'guard.cwd_many', 'guard.no_command', 'guard.hard_denied', 'guard.device_write', 'guard.config_denied',
  'guard.download_exec', 'guard.irreversible', 'guard.write_readonly', 'guard.path_unresolved', 'guard.self_port', 'scope.deny',
  'scope.cmd_subst', 'scope.other_home', 'scope.unknown_env', 'scope.glob_dotdot', 'scope.hazard_prefix', 'scope.hazard_stream', 'scope.hazard_device', 'scope.secret', 'scope.deny_list',
  'lex.denied', 'lex.curly_quote', 'lex.dash', 'lex.space', 'lex.fullwidth', 'lex.control', 'lex.depth', 'lex.unclosed', 'lex.backtick', 'lex.backslash', 'lex.parse_token',
  'lex.block_comment', 'lex.provider_var', 'lex.dollar_form', 'lex.fd', 'lex.dev_net', 'lex.here_expand', 'lex.tilde_user', 'lex.ps_expand', 'lex.here_string', 'lex.ansi_c',
  'lex.unexpected', 'lex.chain_op', 'lex.bash_sub',
  'hard.fs_create', 'hard.disk_format', 'hard.disk_ops', 'hard.disk_wipe', 'hard.backup', 'hard.os_stop', 'hard.os_restart', 'hard.boot', 'hard.shadow', 'hard.exec_policy', 'hard.registry', 'hard.ownership',
  'hard.password', 'hard.user_add', 'hard.user_del', 'hard.net', 'hard.schedule',
  'list.winargs', 'list.winargs_ps',
  'web.secret_text', 'web.password_input', 'web.long_query', 'web.fetch_off', 'web.search_off', 'web.scout_fetch_limit',
  'web.research_fetch_limit', 'web.research_search_limit', 'web.research_time', 'web.research_unseen', 'web.research_bang',
  'file.outside', 'file.root_write', 'file.root_read', 'file.root_sep', 'file.readonly', 'file.symlink',
  'wt.git_shared', 'wt.write_main', 'wt.push_beat', 'wt.main_path', 'wt.opaque', 'wt.git_env', 'wt.outside_path',
  'fix.outside', 'fix.push', 'fix.network', 'fix.background',
] as const;

const OWNER = [
  'guard.write_git', 'guard.write_instructions', 'guard.write_persona', 'guard.write_skill',
  'guard.touch_git', 'guard.touch_instructions', 'guard.touch_persona', 'guard.touch_skill',
  'list.write_ancestor', 'list.tool_config', 'list.secret_in_deps', 'list.git_config', 'list.git_identity', 'code.git_config',
  'file.git', 'file.tool_config', 'file.persona', 'file.skill', 'file.skill_auto', 'file.skill_off', 'file.instructions',
] as const;

const POLICY = ['guard.needs_approval'] as const;

const PRODUCT_CODE = ['code.file_run', 'code.stdin_run', 'code.cmd_is_file', 'code.arg_file', 'code.project_tool', 'list.lang_run', 'list.node_test', 'list.npm_script'] as const;

const PRODUCT_IF = ['list.external', 'list.command', 'list.git_commit'] as const;

const JUDGE = [
  'guard.substitution', 'guard.interpreter', 'guard.cd_unresolved', 'guard.cd_outside', 'guard.relative_unknown', 'guard.touches_outside',
  'list.flag', 'list.form', 'list.arith', 'list.dynamic', 'list.shape', 'list.env', 'list.install', 'list.git_unreadable', 'list.tool_rc', 'list.tool_rc_cwd',
  'list.git_moves', 'list.npm_rc', 'list.npm_rc_unknown', 'list.git_remote', 'list.git_old', 'list.git_hooks', 'list.git_remote_local', 'list.git_hooks_path', 'list.git_net',
  'list.git_write', 'list.git_push', 'list.cmd_syntax', 'list.ps_write', 'list.ps_pipe', 'list.download', 'list.url_glob', 'list.file_list', 'list.pipe_read', 'list.write_dynamic',
  'list.protected_write', 'list.expand', 'list.lan', 'list.long_query', 'list.redirect', 'list.header', 'list.send', 'list.read_dynamic', 'list.wild_many', 'list.cwd_unknown',
  'shape.call', 'shape.dot_source', 'shape.splat', 'shape.background', 'shape.function', 'shape.process_out', 'shape.pipe_stderr', 'shape.control', 'shape.control_opaque', 'shape.script_block',
  'shape.static', 'shape.cast', 'shape.method', 'shape.expr', 'shape.replace_block',
  'code.spawn', 'code.powershell', 'code.launcher', 'code.wrapped_unknown', 'code.unknown_target', 'code.env', 'code.loopback', 'code.self_touch', 'code.self_hint', 'code.limits',
  'code.preview_missing', 'code.preview_unreadable',
  'ask.package', 'ask.npx', 'ask.system_package', 'ask.curl', 'ask.wget', 'ask.powershell', 'ask.remote', 'ask.git_push', 'ask.git_remote', 'ask.gh', 'ask.container', 'ask.service',
] as const;

export const REASON_ORDER: ReadonlyMap<string, Order> = new Map<string, Order>([
  ...REFUSED.map(key => [key, 1] as const),
  ...OWNER.map(key => [key, 3] as const),
  ...POLICY.map(key => [key, 3] as const),
  ...PRODUCT_CODE.map(key => [key, 4] as const),
  ...PRODUCT_IF.map(key => [key, 4] as const),
  ...JUDGE.map(key => [key, 5] as const),
]);

export const GIT_IDENTITY_KEY = 'list.git_identity';
export const OWNER_KEYS: ReadonlySet<string> = new Set(OWNER);
export const POLICY_KEYS: ReadonlySet<string> = new Set(POLICY);
export const PRODUCT_CODE_KEYS: ReadonlySet<string> = new Set(PRODUCT_CODE);

export const SERVICE_PROGRAMS: ReadonlySet<string> = new Set([
  'systemctl', 'service', 'sc', 'launchctl', 'schtasks', 'reg', 'shutdown', 'reboot', 'halt', 'poweroff', 'net', 'netsh', 'crontab', 'at', 'initctl', 'rc-service',
  'update-rc.d', 'chkconfig', 'set-service', 'start-service', 'stop-service', 'restart-service', 'new-service', 'remove-service', 'suspend-service', 'resume-service',
  'stop-computer', 'restart-computer', 'set-itemproperty', 'bcdedit', 'diskpart', 'format', 'sudo', 'su', 'doas', 'runas', 'pkexec',
]);

export const DEV_RUNNERS: ReadonlySet<string> = new Set(['make', 'gmake', 'nmake', 'just', 'rake', 'ninja', 'pytest', 'jest', 'vitest', 'mocha', 'tox', 'nox']);

export function ownerKeysOf(keys: Iterable<string>): string[] {
  return [...new Set([...keys].filter(key => OWNER_KEYS.has(key)))];
}

export function refusedKeysOf(keys: Iterable<string>): string[] {
  return [...new Set([...keys].filter(key => REASON_ORDER.get(key) === 1))];
}

export const NODE_SKIP_FLAG = /^(?:--disable-warning=[A-Za-z0-9_-]+|--no-warnings|--enable-source-maps|--experimental-strip-types|--experimental-transform-types)$/u;

export function nodeFileIndex(program: string, args: ReadonlyArray<{ text: string }>): number {
  if (!/^node(?:js)?$/u.test(program)) return 0;
  let at = 0;
  while (at < args.length && NODE_SKIP_FLAG.test(args[at]!.text)) at++;
  return at;
}

// どれも、あとで起こすプロセスの起動時に読み込まれ、コードを動かせる（NODE_OPTIONS=--require ./put.js など）。NODE_ENV のような設定だけの値は含めない
export const CODE_ENV = new RegExp(`^(?:${[
  'NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV', 'PYTHONSTARTUP', 'PYTHONPATH', 'PYTHONHOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  'PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'RUBYLIB', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH', 'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_EXTERNAL_DIFF', 'GIT_ASKPASS',
  'GIT_PAGER', 'GIT_EDITOR', 'GIT_EXEC_PATH', 'GIT_PROXY_COMMAND', 'GIT_TEMPLATE_DIR', 'GIT_CONFIG\\w*', 'PAGER', 'EDITOR', 'VISUAL', 'PROMPT_COMMAND', 'PATH', 'PATHEXT', 'PSMODULEPATH', 'COMSPEC',
  'SHELL', 'RUSTC_WRAPPER', 'CARGO_BUILD_RUSTC_WRAPPER', 'GOFLAGS', 'NPM_CONFIG_SCRIPT_SHELL', 'NPM_CONFIG_NODE_OPTIONS',
].join('|')})$`, 'iu');
