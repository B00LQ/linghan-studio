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
import { fetchSettings, listWorkflows, saveSettings, testBackend, type BackendTest, type SettingField, type SettingsState, type WorkflowInfo } from '../api.ts'

/** 每组字段的标题。 */
const GROUP_TITLE: Record<SettingField['group'], string> = {
  image: '出图 · 本地 ComfyUI 或火山方舟',
  text: '文本 · 文本节点用它写',
  audio: '语音 · 音频节点用它念',
}

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

  const load = useCallback(async () => {
    try {
      setState(await fetchSettings())
      setDraft({})
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '读设置失败')
    }
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
                  <button
                    type="button"
                    className="link"
                    data-testid={`test-${group}`}
                    disabled={busy !== ''}
                    onClick={() => { void probe(group) }}
                  >
                    {busy === group ? '测试中…' : '测一下'}
                  </button>
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
