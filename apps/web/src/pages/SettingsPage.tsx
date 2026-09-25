/**
 * 设置页。
 *
 * 存在的理由很直接：**别人拿到这份代码之后，第一件事就是「接上我自己的后端」**，
 * 而在这之前，ComfyUI 地址、各个 Key 只能改环境变量、重启容器 —— 一个还没跑起来的人，
 * 要先去翻文档才知道该设哪个变量名。这一页把那些变量摆出来、能改、能测，
 * 并且把「现在到底通没通」写成一句人话。
 *
 * 三层取值：**设置页 → 环境变量 → 内置默认**。所以两种用法都成立：纯环境变量部署的人
 * 什么都不用改；在界面上改过的值一定压得住环境变量（否则「改了没反应」最难查）。
 * 改完**立刻生效**，不用重启 —— 配置是就地覆盖的，驱动与后端每次调用都重新读。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  applyUpdate, fetchBackup, fetchSettings, fetchUpdate, listWorkflows, restoreBackup, runBackup, saveSettings,
  fetchCloudLink, setBackupDir, startCloudLogin, testBackend, unbindCloud,
  type BackendTest, type BackupState, type CloudLinkState, type SettingField, type SettingsState, type UpdateState, type WorkflowInfo,
} from '../api.ts'

/** 每组字段的标题。 */
const GROUP_TITLE: Record<SettingField['group'], string> = {
  image: '出图 · 本机 ComfyUI 或自己租的云实例',
  text: '文本 · 文本节点用它写',
  audio: '语音 · 音频节点用它念',
  update: '更新源 · 绿色包自助更新用',
  account: '账号 · 只用来发布作品',
}

/** 有「测一下」的分组（更新源不是后端，没什么可探的）。 */
const PROBE_GROUPS: SettingField['group'][] = ['image', 'text', 'audio']

/** 字节数说成人话。 */
const sizeText = (bytes: number): string => bytes >= 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
  : `${String(Math.max(1, Math.round(bytes / 1024)))} KB`

/** 取值来源怎么念。 */
const SOURCE_LABEL: Record<SettingField['source'], string> = {
  settings: '来自设置页',
  env: '来自环境变量',
  default: '用默认值',
}

/** Props for the settings page. */
export interface SettingsPageProps {
  /** Bumped by the shell after a change elsewhere. */
  refreshToken: number
}

/**
 * Render the settings page.
 * @param props - refresh signal.
 * @returns the page.
 */
export function SettingsPage({ refreshToken }: SettingsPageProps) {
  const [state, setState] = useState<SettingsState | null>(null)
  /** 改动过的字段：key → 新值（空串 = 清掉这条覆盖）。没碰过的键不出现在这里。 */
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [tests, setTests] = useState<Record<string, BackendTest>>({})
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([])
  /** 更新状态：问过之后才有值（不问就不发网络请求）。 */
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  /** 备份状态（「数据安全」一节用）。 */
  const [backup, setBackup] = useState<BackupState | null>(null)
  const [backupDirDraft, setBackupDirDraft] = useState('')
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupNote, setBackupNote] = useState('')
  /** 账号绑定状态（只用来发布作品）。 */
  const [link, setLink] = useState<CloudLinkState | null>(null)
  const [linkBusy, setLinkBusy] = useState(false)
  const [linkNote, setLinkNote] = useState('')

  const load = useCallback(async () => {
    try {
      setState(await fetchSettings())
      setDraft({})
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '读设置失败')
    }
    // 账号绑定：不绑定也能用，但绑了才谈得上发布。
    void fetchCloudLink().then(setLink).catch(() => { setLink(null) })
    // 备份状态：这一页要显示「上次什么时候备的、备到哪」，失败也要看得见。
    void fetchBackup()
      .then((result) => { setBackup(result); setBackupDirDraft(result.dir) })
      .catch(() => { setBackup(null) })
    // 工作流列表顺带拿来：第 18 条那个「官方 PDD 要装插件与权重」的引导要用它说的缺什么。
    void listWorkflows()
      .then((result) => { setWorkflows(result.workflows) })
      .catch(() => { /* 工作流页自己会报 */ })
  }, [])

  useEffect(() => { void load() }, [load, refreshToken])

  const save = async (): Promise<void> => {
    if (Object.keys(draft).length === 0) { setMessage('没有改动'); return }
    setBusy('save')
    try {
      const result = await saveSettings(draft)
      setState(result)
      setDraft({})
      setMessage(`已保存 ${String(result.saved.length)} 项，立刻生效（不用重启）`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败')
    } finally {
      setBusy('')
    }
  }

  const probe = async (target: 'image' | 'text' | 'audio'): Promise<void> => {
    setBusy(target)
    try {
      const result = await testBackend(target)
      setTests((current) => ({ ...current, [target]: result }))
    } catch (error) {
      setTests((current) => ({ ...current, [target]: { target, ok: false, detail: error instanceof Error ? error.message : '测试失败' } }))
    } finally {
      setBusy('')
    }
  }

  const changed = Object.keys(draft).length
  const pdd = workflows.find((item) => item.id === 'minimax-h3-video-pdd')
  const pddMissing = [...(pdd?.missingNodes ?? []), ...(pdd?.missingModels ?? [])]

  /** 问更新源。**只在人点了之后才发请求**：打开设置页不该顺带联网。 */
  const checkUpdate = async (): Promise<void> => {
    setUpdateBusy(true)
    try {
      setUpdate(await fetchUpdate())
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '检查更新失败')
    } finally {
      setUpdateBusy(false)
    }
  }

  /** 装最新版。装完要重启才生效 —— 正在跑的进程替换不了自己，这一点界面上说清楚。 */
  const installUpdate = async (): Promise<void> => {
    setUpdateBusy(true)
    try {
      const result = await applyUpdate()
      setMessage(`已装好 ${result.version}（${String(result.files)} 个文件）：重启 Studio 之后生效`)
      setUpdate(await fetchUpdate())
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '安装失败')
    } finally {
      setUpdateBusy(false)
    }
  }

  return (
    <div className="page settings-page">
      <header className="page-head">
        <h1>设置</h1>
        <p className="muted">
          这里改的值立刻生效，不用重启；环境变量仍然有效，只是设置页的值压得住它。
        </p>
      </header>

      {state === null ? <p className="muted">正在读设置…</p> : (
        <>
          {(Object.keys(GROUP_TITLE) as SettingField['group'][]).map((group) => {
            const fields = state.settings.filter((item) => item.group === group)
            if (fields.length === 0) return null
            const test = tests[group]
            return (
              <section className="settings-group" key={group} data-testid={`settings-${group}`}>
                <header>
                  <h2>{GROUP_TITLE[group]}</h2>
                  {PROBE_GROUPS.includes(group) ? (
                    <button
                      type="button"
                      className="link"
                      data-testid={`test-${group}`}
                      disabled={busy !== ''}
                      onClick={() => { void probe(group as 'image' | 'text' | 'audio') }}
                    >
                      {busy === group ? '测试中…' : '测一下'}
                    </button>
                  ) : null}
                </header>
                {fields.map((field) => (
                  <div className="setting-row" key={field.key} data-testid={`setting-${field.key}`}>
                    <div className="setting-head">
                      <span className="setting-label">{field.label}</span>
                      <span className={`setting-source is-${field.source}`}>{SOURCE_LABEL[field.source]}</span>
                      {field.set && field.source !== 'settings'
                        ? <span className="setting-flag">已配置</span>
                        : null}
                    </div>
                    <input
                      type={field.secret === true ? 'password' : 'text'}
                      value={draft[field.key] ?? (field.secret === true ? '' : field.value)}
                      placeholder={field.secret === true && field.set ? '已配置（留空表示不改）' : (field.placeholder ?? '')}
                      onChange={(event) => { setDraft((current) => ({ ...current, [field.key]: event.target.value })) }}
                    />
                    {/* 清掉这条覆盖：退回环境变量/默认。机密字段也只能这样清（不回显）。 */}
                    {field.set || field.key in draft ? (
                      <button
                        type="button"
                        className="link"
                        onClick={() => { setDraft((current) => ({ ...current, [field.key]: '' })) }}
                      >清除</button>
                    ) : null}
                    <p className="setting-hint">
                      {field.hint ?? ''}
                      {field.fromEnv && field.source === 'settings' ? '（环境变量里也有一份，清掉这条会退回它）' : ''}
                    </p>
                  </div>
                ))}
                {test === undefined ? null : (
                  <p className={`setting-test ${test.ok ? 'is-ok' : 'is-bad'}`}>
                    {test.ok ? '✓' : '✗'} {test.detail ?? test.note ?? '没有细节'}
                    {(test.problems ?? []).length === 0 ? '' : ` · ${(test.problems ?? []).join('；')}`}
                  </p>
                )}
              </section>
            )
          })}

          <div className="settings-actions">
            <button type="button" className="primary" data-testid="save-settings" disabled={busy !== '' || changed === 0} onClick={() => { void save() }}>
              {changed === 0 ? '没有改动' : `保存 ${String(changed)} 项`}
            </button>
            {message === '' ? null : <span className="setting-message" data-testid="settings-message">{message}</span>}
          </div>

          <section className="settings-group" data-testid="settings-account">
            <header>
              <h2>账号 · 只用来发布作品</h2>
              {link === null || !link.bound ? null : (
                <button type="button" className="link" data-testid="cloud-unbind" onClick={() => {
                  void unbindCloud().then(() => { setLinkNote('已解绑（云端那边的设备列表里仍可单独撤销）'); void fetchCloudLink().then(setLink) })
                }}>解绑</button>
              )}
            </header>
            {/* 这一节要反复说清一件事：**不绑定账号也能用**。画布、算力、备份都在本机，
                账号只为一件事 —— 把作品发布到服务器上给人看。 */}
            <p className="muted">
              画布、算力、备份都在你自己的机器上，不绑定账号照样能用。
              绑定只有一个用处：把作品发布到服务器（主页）给别人看。
            </p>
            {link === null ? <p className="muted">正在读绑定状态…</p> : link.bound ? (
              <p className="setting-test is-ok">
                ✓ 已绑定 {link.email === '' ? '（暂时读不到邮箱，可能连不上服务器）' : link.email}
                {link.reachable ? '' : ' · 现在连不上服务器，发布时会再试'}
              </p>
            ) : (
              <div className="settings-actions">
                <button
                  type="button" className="primary" data-testid="cloud-bind" disabled={linkBusy}
                  onClick={() => {
                    setLinkBusy(true)
                    setLinkNote('正在打开浏览器…')
                    void startCloudLogin()
                      .then((result) => {
                        // 授权页在浏览器里，回跳会打到本机服务上（本机服务再用码换令牌）。
                        window.open(result.url, '_blank', 'noopener')
                        setLinkNote('浏览器里登录并点「授权这台电脑」，这里会自动变成已绑定')
                        // 授权完成后本机服务已经存下令牌，轮询一下就行（不用刷新页面）。
                        let tries = 0
                        const timer = window.setInterval(() => {
                          tries += 1
                          void fetchCloudLink().then((state) => {
                            if (state.bound || tries > 60) {
                              window.clearInterval(timer)
                              setLink(state)
                              setLinkNote(state.bound ? '绑定成功' : '还没完成授权，再点一次「绑定账号」试试')
                              setLinkBusy(false)
                            }
                          })
                        }, 2000)
                      })
                      .catch((problem: unknown) => {
                        setLinkNote(problem instanceof Error ? problem.message : '打不开授权页')
                        setLinkBusy(false)
                      })
                  }}
                >绑定账号</button>
                <span className="muted">会用浏览器打开授权页：密码只填在浏览器里，不经过 Studio。</span>
              </div>
            )}
            {linkNote === '' ? null : <p className="setting-test" data-testid="cloud-note">{linkNote}</p>}
          </section>

          <section className="settings-group" data-testid="settings-backup">
            <header>
              <h2>数据安全 · 备份</h2>
              <button
                type="button" className="link" data-testid="backup-now" disabled={backupBusy}
                onClick={() => {
                  setBackupBusy(true)
                  setBackupNote('正在备份…')
                  void runBackup()
                    .then((result) => { setBackup(result.status); setBackupNote(`已备份：${result.point.id}`) })
                    .catch((problem: unknown) => { setBackupNote(problem instanceof Error ? problem.message : '备份失败') })
                    .finally(() => { setBackupBusy(false) })
                }}
              >立即备份</button>
            </header>
            {/* 这一节存在的理由：**画布与素材只在这台机器上**（服务器不存）。
                所以「硬盘坏 / 重装系统 / 换电脑」全靠备份与导出 —— 这一页必须把话说清楚，
                并且让人一眼看到「上次备份是什么时候、备到哪、有没有失败」。 */}
            <p className="muted">
              画布与素材只存在这台机器上（服务器不存）。硬盘坏、重装系统、换电脑之前，
              请确认这里有最近的备份，或者用画布卡片上的「导出画布包」带走。
            </p>
            {backup === null ? <p className="muted">正在读备份状态…</p> : (
              <>
                {backup.restoredFromBackup === true ? (
                  <p className="setting-test is-ok">✓ 这次启动用的是备份里的数据（你之前点过「从备份恢复」）</p>
                ) : null}
                <p className="muted">
                  备份目录：<code>{backup.dir}</code>
                  {' · '}
                  上次备份：{backup.lastAt === '' ? '还没有做过' : new Date(backup.lastAt.replace('T', ' ')).toLocaleString('zh-CN')}
                  {' · '}
                  素材镜像：{String(backup.mirrorFiles)} 个文件 / {sizeText(backup.mirrorBytes)}
                  {' · '}
                  保留 {String(backup.keep)} 份
                </p>
                {backup.lastError === '' ? null : <p className="setting-test is-bad">✗ 上次备份有问题：{backup.lastError}</p>}
                {backup.pendingRestore === '' ? null : (
                  <p className="setting-test is-ok">✓ 已经准备好从「{backup.pendingRestore}」恢复：重启 Studio 之后生效</p>
                )}

                <div className="setting-row">
                  <div className="setting-head"><span className="setting-label">备份放到哪</span></div>
                  <input
                    value={backupDirDraft}
                    onChange={(event) => { setBackupDirDraft(event.target.value) }}
                    placeholder="例如 D:\\backup\\studio"
                  />
                  <button
                    type="button" className="link" data-testid="backup-set-dir" disabled={backupBusy}
                    onClick={() => {
                      setBackupBusy(true)
                      void setBackupDir(backupDirDraft)
                        .then((result) => { setBackup(result.status); setBackupNote('备份目录已改') })
                        .catch((problem: unknown) => { setBackupNote(problem instanceof Error ? problem.message : '改不了这个目录') })
                        .finally(() => { setBackupBusy(false) })
                    }}
                  >用这个目录</button>
                  <p className="setting-hint">
                    建议指到另一块盘或网盘同步目录：同盘的备份挡不住硬盘坏。
                    {backup.suggestions.length === 0 ? '（这台机器上没探测到常见的网盘目录，可以自己填。）' : ''}
                  </p>
                  {backup.suggestions.map((item) => (
                    <button
                      key={item.dir}
                      type="button" className="link"
                      data-testid={`backup-suggest-${item.label}`}
                      onClick={() => { setBackupDirDraft(`${item.dir}\\LINGHAN-Studio-backup`) }}
                    >用「{item.label}」：{item.dir}</button>
                  ))}
                </div>

                {backup.points.length === 0 ? null : (
                  <details className="workflow-params" open data-testid="backup-points">
                    <summary>备份点（点「恢复」会先自动备份当前状态，重启后生效）</summary>
                    {backup.points.map((point) => (
                      <div className="row" key={point.id}>
                        <span className="grow">
                          {new Date(point.createdAt.replace('T', ' ')).toLocaleString('zh-CN')}
                          <br />
                          <span className="muted">{point.reason === '' ? '（没有备注）' : point.reason} · {sizeText(point.bytes)}</span>
                        </span>
                        <button
                          type="button" className="danger" disabled={backupBusy}
                          onClick={() => {
                            if (!window.confirm(`从「${point.createdAt}」恢复？当前状态会先自动备份一份，恢复在重启 Studio 之后生效。`)) return
                            setBackupBusy(true)
                            void restoreBackup(point.id)
                              .then((result) => { setBackup(result.status); setBackupNote(result.note) })
                              .catch((problem: unknown) => { setBackupNote(problem instanceof Error ? problem.message : '恢复失败') })
                              .finally(() => { setBackupBusy(false) })
                          }}
                        >恢复</button>
                      </div>
                    ))}
                  </details>
                )}
                {backupNote === '' ? null : <p className="setting-test" data-testid="backup-note">{backupNote}</p>}
              </>
            )}
          </section>

          <section className="settings-group" data-testid="settings-update">
            <header>
              <h2>软件更新</h2>
              <button type="button" className="link" data-testid="check-update" disabled={updateBusy} onClick={() => { void checkUpdate() }}>
                {updateBusy ? '检查中…' : '检查更新'}
              </button>
            </header>
            {update === null ? (
              <p className="muted">
                绿色包可以在这一页自助更新（下载 → 校验 → 换目录 → 重启生效）。
                Docker 部署请拉新镜像，源码运行请 <code>git pull</code>：那两种方式不该由页面自己替换文件。
              </p>
            ) : (
              <>
                <p className="muted">
                  当前版本 <code>{update.current}</code>
                  {update.configured ? ` · 更新源里的最新版 ${update.latest === '' ? '读不到' : update.latest}` : ' · 没有配置更新源'}
                  {update.selfUpdate ? '' : ' · 这个部署方式不能自助更新'}
                </p>
                {update.error === '' ? null : <p className="setting-test is-bad">✗ {update.error}</p>}
                {update.available ? (
                  <>
                    <p className="setting-test is-ok">✓ 有新版本 {update.latest}{update.notes === '' ? '' : `：${update.notes}`}</p>
                    {update.selfUpdate ? (
                      <div className="settings-actions">
                        <button type="button" className="primary" data-testid="install-update" disabled={updateBusy} onClick={() => { void installUpdate() }}>
                          装这一版
                        </button>
                        <span className="muted">装完要重启 Studio 才生效。</span>
                      </div>
                    ) : (
                      <p className="muted">这个部署方式（Docker / 源码）请按部署说明升级，页面不会自己替换文件。</p>
                    )}
                  </>
                ) : update.configured && update.error === '' ? <p className="setting-test is-ok">✓ 已经是最新版</p> : null}
                {update.installed.length === 0 ? null : (
                  <p className="muted">本地已有的版本：{update.installed.join('、')}（换 <code>{`${update.home}\\current.txt`}</code> 就能回退）</p>
                )}
              </>
            )}
          </section>

          <section className="settings-group settings-guide">
            <header><h2>接上自己的后端</h2></header>
            <ol>
              <li>
                <b>起本地算力</b>：ComfyUI 必须自己起着（`--listen 0.0.0.0`，否则容器连不上）。
                它是出图/出片的唯一后端，没起也能用占位图先把流程跑通。
              </li>
              <li>
                <b>填地址</b>：容器里跑 Studio 就用 <code>http://host.docker.internal:8188</code>；
                本机直跑用 <code>http://127.0.0.1:8188</code>。填完点上面的「测一下」。
              </li>
              <li>
                <b>放模型文件</b>：缺哪个文件 / 缺哪个节点，「测一下」与工作流页都会点名。
              </li>
              <li>
                <b>文本与语音</b>：接任意 OpenAI 兼容的接口（ChatGPT / DeepSeek / Moonshot / 方舟）。
                不配也能按 ↑，只是会写下占位文本或占位音 —— 那是为了让人看清「链路通、模型没配」。
              </li>
            </ol>
          </section>

          <section className="settings-group settings-guide" data-testid="settings-pdd">
            <header><h2>官方 PDD 加速（那条视频工作流）</h2></header>
            {pdd === undefined ? (
              <p className="muted">工作流库里没有这一条（它随仓库内置，应该总在）。</p>
            ) : pddMissing.length === 0 ? (
              <p className="setting-test is-ok">✓ 插件与权重都在，这条工作流可以直接出片。</p>
            ) : (
              <>
                <p className="setting-test is-bad">✗ 还缺：{pddMissing.join('、')}</p>
                <p className="muted">缺东西时它不会出现在画布的工作流下拉里（菜单只列这台机器真能跑的），装好之后刷新页面就有了。</p>
                <pre className="settings-code">{[
                  '# 1. 插件（装完必须重启 ComfyUI 才会加载）',
                  'git clone https://github.com/Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc \\',
                  '    <ComfyUI>/custom_nodes/ComfyUI-MiniMax-H3-PDD-Acc',
                  '',
                  '# 2. 权重（约 1.4 GB）放进 <ComfyUI>/models/pdd_acc/',
                  '#    huggingface.co/alibaba-pai/MiniMax-H3-Acc-LoRAs',
                  '#      → MiniMax-H3-FL2VA-Acc-8Step.safetensors',
                ].join('\n')}</pre>
              </>
            )}
          </section>

          <section className="settings-group">
            <header><h2>只读信息</h2></header>
            <p className="muted">
              数据目录：<code>{state.dataDir}</code>（数据库与素材都在这里，改了要重启）<br />
              端口：<code>{state.port}</code> · 访问密码：{state.passwordSet ? '已设置' : '没有设置（登录门已关闭）'}
            </p>
          </section>
        </>
      )}
    </div>
  )
}
