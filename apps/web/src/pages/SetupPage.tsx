/**
 * 首启向导。
 *
 * 为什么要有它：一个刚拿到绿色包的人打开浏览器，看到的是一张空画布，而**后面还有三件事
 * 没做**（设访问密码、选后端、填地址）—— 这三件事原本只写在文档里。向导把它们按顺序问一遍，
 * 每一步都解释「为什么要问」。
 *
 * 两条规矩：
 * - **每一步都能跳过**，只是跳过的代价写在按钮旁边（不设密码 = 同一台机器上的人都能改你的画布）。
 *   把「必须这样」做成硬性流程，人只会去找别的办法绕。
 * - **设完之后当场验一次**：保存完立刻探一次后端，通了说通了，不通就说去设置页改。
 *   这是「配完了到底能不能用」和「我配了但不知道对不对」的区别。
 */
import { useEffect, useState } from 'react'
import { fetchBackup, setBackupDir, submitSetup, testBackend, type BackendTest, type SessionInfo } from '../api.ts'

/** 后端三选一的选项文案。 */
const DRIVERS: { id: string; label: string; hint: string }[] = [
  { id: 'stub', label: '先不接（占位图）', hint: '不需要任何依赖，先把画布、连线、版本这些跑通；出的是占位渐变图。' },
  { id: 'comfyui', label: '本机 ComfyUI', hint: '用自己的显卡出图/出片。ComfyUI 要自己起着，地址填下面的框。' },
  { id: 'ark', label: '火山方舟（云端）', hint: '用云上的图像模型，要一个 API Key，不用显卡。' },
]

/** Props for {@link SetupPage}. */
export interface SetupPageProps {
  /** 服务端报告的部署信息（版本、数据目录）。 */
  session: SessionInfo
  /** 配完（或跳过）之后叫外壳重新问一次会话。 */
  onDone: () => void
}

/**
 * Render the first-run wizard.
 * @param props - see {@link SetupPageProps}.
 * @returns the wizard.
 */
export function SetupPage({ session, onDone }: SetupPageProps) {
  const [step, setStep] = useState(0)
  const [driver, setDriver] = useState('stub')
  const [comfyUrl, setComfyUrl] = useState('http://127.0.0.1:8188')
  const [arkKey, setArkKey] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /** 保存之后探一次后端的结论。 */
  const [probe, setProbe] = useState<BackendTest | null>(null)
  /** 备份位置：探测到的网盘目录 + 用户当前的选择。 */
  const [backupDirs, setBackupDirs] = useState<{ label: string; dir: string }[]>([])
  const [backupDir, setBackupDirDraft] = useState('')
  const [backupNote, setBackupNote] = useState('')

  // 首启时问一句「备份放哪」：这台机器上的网盘目录由服务端探测（用户不知道自己的网盘在哪）。
  useEffect(() => {
    void fetchBackup()
      .then((result) => { setBackupDirs(result.suggestions); setBackupDirDraft('') })
      .catch(() => { setBackupDirs([]) })
  }, [])

  /** 把选择落到服务端（写进设置，重启后仍然用它）。 */
  const commitBackupDir = (dir: string): void => {
    if (dir.trim() === '') return
    void setBackupDir(`${dir.trim()}\\LINGHAN-Studio-backup`)
      .then(() => { setBackupNote(`备份将放在 ${dir.trim()}\\LINGHAN-Studio-backup`) })
      .catch((problem: unknown) => { setBackupNote(problem instanceof Error ? problem.message : '这个目录用不了') })
  }

  const mismatch = password !== '' && repeat !== '' && password !== repeat

  /**
   * 从「访问密码」这一步往前走。
   *
   * 校验放在**这一步**而不是最后一步：等填完后端再说「密码太短」，
   * 人会以为自己前面哪一步填错了。
   */
  const toBackend = (): void => {
    if (mismatch) { setError('两次输入的密码不一样'); return }
    if (password !== '' && password.length < 6) { setError('密码至少 6 位（这台机器上的人能改你的画布）'); return }
    setError('')
    setStep(2)
  }

  /** 真正写下去：一次提交，服务端写完就把这个人登进来。 */
  const finish = async (): Promise<void> => {
    if (mismatch) { setError('两次输入的密码不一样'); return }
    if (password !== '' && password.length < 6) { setError('密码至少 6 位'); return }
    setBusy(true)
    setError('')
    try {
      await submitSetup({
        password,
        values: {
          STUDIO_IMAGE_DRIVER: driver,
          ...(driver === 'comfyui' ? { COMFYUI_URL: comfyUrl } : {}),
          ...(driver === 'ark' && arkKey !== '' ? { ARK_API_KEY: arkKey } : {}),
        },
      })
      setStep(3)
      // 保存完立刻验一次：这时候已经有会话了（服务端顺手把向导里的人登了进去）。
      if (driver !== 'stub') {
        try {
          setProbe(await testBackend('image'))
        } catch (problem) {
          setProbe({ target: 'image', ok: false, detail: problem instanceof Error ? problem.message : '测不了' })
        }
      }
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gate setup-gate" data-testid="setup-wizard">
      <div className="setup-card">
        <header>
          <h1>Studio 首次启动</h1>
          <p className="muted">三步，一分钟。每一步都能跳过 —— 跳过的代价写在按钮旁边。</p>
          <div className="setup-steps" data-testid="setup-steps">
            {['这台机器', '访问密码', '出图后端', '开始用'].map((title, index) => (
              <span key={title} className={index === step ? 'active' : index < step ? 'done' : ''}>
                {index + 1}. {title}
              </span>
            ))}
          </div>
        </header>

        {step === 0 ? (
          <section>
            <h2>东西都存在哪里</h2>
            <p>
              数据目录：<code>{session.dataDir ?? '（由环境变量 STUDIO_DATA_DIR 决定）'}</code>
            </p>
            <p className="muted">
              画布、生成结果、上传的素材全在这里。绿色包默认存在自己的 <code>data</code> 目录下，
              所以整个文件夹拷走就是搬家；想放到别处就设环境变量 <code>STUDIO_DATA_DIR</code>。
            </p>
            <p className="muted">当前版本 {session.version ?? '未知'}。</p>

            {/* 备份放哪：**这一步值得单独问**。画布与素材只在这台机器上（服务器不存），
                而备份放在同一个硬盘上，硬盘坏了备份也跟着坏 —— 那这个功能就白做了。 */}
            <h2 style={{ marginTop: 18 }}>备份放哪</h2>
            <p className="muted">
              每天会自动备份一次（保留 7 份）。放在同一个硬盘上，硬盘坏了备份也没了；
              放到另一块盘或网盘同步目录，重装系统、换电脑都能找回来。
            </p>
            <div className="setup-drivers">
              {backupDirs.length === 0 ? (
                <p className="muted">这台机器上没探测到常见的网盘目录（OneDrive / 坚果云 / 百度网盘…）。用默认位置就行，之后也能在设置页改。</p>
              ) : backupDirs.map((dir) => (
                <button
                  key={dir.label}
                  type="button"
                  className={`setup-driver${backupDir === dir.dir ? ' active' : ''}`}
                  data-testid={`setup-backup-${dir.label}`}
                  onClick={() => { setBackupDirDraft(dir.dir); commitBackupDir(dir.dir) }}
                >
                  <strong>用「{dir.label}」</strong>
                  <span className="muted">{dir.dir}</span>
                </button>
              ))}
            </div>
            <label>
              或者自己填一个目录（留空 = 用安装目录下的 backups/）
              <input
                value={backupDir}
                data-testid="setup-backup-dir"
                onChange={(event) => { setBackupDirDraft(event.target.value) }}
                onBlur={(event) => { commitBackupDir(event.target.value) }}
                placeholder="例如 D:\\backup\\studio"
              />
            </label>
            {backupNote === '' ? null : <p className="muted" data-testid="setup-backup-note">{backupNote}</p>}

            <div className="setup-actions">
              <button type="button" className="primary" data-testid="setup-next" onClick={() => { setStep(1) }}>下一步</button>
            </div>
          </section>
        ) : null}

        {step === 1 ? (
          <section>
            <h2>设一个访问密码</h2>
            <p className="muted">
              不设密码时，**任何能打开这个地址的人都能改你的画布、花你的 API Key**。
              本机自己用可以不设；只要这台机器在局域网里，就该设一个。
            </p>
            <label>
              密码
              <input
                type="password" value={password} autoFocus data-testid="setup-password"
                onChange={(event) => { setPassword(event.target.value) }}
              />
            </label>
            <label>
              再说一遍
              <input
                type="password" value={repeat} data-testid="setup-password-repeat"
                onChange={(event) => { setRepeat(event.target.value) }}
              />
            </label>
            {mismatch ? <p className="error">两次输入的密码不一样</p> : null}
            <div className="setup-actions">
              <button type="button" onClick={() => { setStep(0) }}>上一步</button>
              <button type="button" className="primary" data-testid="setup-next" onClick={toBackend}>下一步</button>
              <button
                type="button" className="link" data-testid="setup-skip-password"
                onClick={() => { setPassword(''); setRepeat(''); setError(''); setStep(2) }}
              >先不设（本机自用）</button>
            </div>
          </section>
        ) : null}

        {step === 2 ? (
          <section>
            <h2>用哪个后端出图</h2>
            <div className="setup-drivers">
              {DRIVERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`setup-driver${driver === item.id ? ' active' : ''}`}
                  data-testid={`setup-driver-${item.id}`}
                  onClick={() => { setDriver(item.id) }}
                >
                  <strong>{item.label}</strong>
                  <span className="muted">{item.hint}</span>
                </button>
              ))}
            </div>
            {driver === 'comfyui' ? (
              <label>
                ComfyUI 地址
                <input
                  value={comfyUrl} data-testid="setup-comfy-url"
                  onChange={(event) => { setComfyUrl(event.target.value) }}
                />
                <span className="muted">
                  绿色包和 ComfyUI 在同一台机器上就用 127.0.0.1；ComfyUI 在另一台机器上就填它的局域网地址。
                </span>
              </label>
            ) : null}
            {driver === 'ark' ? (
              <label>
                方舟 API Key
                <input
                  type="password" value={arkKey} data-testid="setup-ark-key"
                  onChange={(event) => { setArkKey(event.target.value) }}
                />
              </label>
            ) : null}
            <div className="setup-actions">
              <button type="button" onClick={() => { setStep(1) }}>上一步</button>
              <button type="button" className="primary" data-testid="setup-finish" disabled={busy} onClick={() => { void finish() }}>
                {busy ? '保存中…' : '完成'}
              </button>
            </div>
          </section>
        ) : null}

        {step === 3 ? (
          <section>
            <h2>配好了</h2>
            {probe === null ? null : (
              <p className={`setting-test ${probe.ok ? 'is-ok' : 'is-bad'}`} data-testid="setup-probe">
                {probe.ok ? '✓' : '✗'} {probe.detail ?? probe.note ?? '没有细节'}
              </p>
            )}
            {probe !== null && !probe.ok ? (
              <p className="muted">没通也不要紧：设置页里可以改地址、再点「测一下」，而且不接后端也能用占位图把流程跑通。</p>
            ) : null}
            <p className="muted">
              {password === '' ? '⚠ 没有设访问密码：这个地址上的人都能改你的画布。' : '访问密码已设置。'}
            </p>
            <div className="setup-actions">
              <button type="button" className="primary" data-testid="setup-done" onClick={onDone}>进入画布</button>
            </div>
          </section>
        ) : null}

        {error === '' ? null : <p className="error" data-testid="setup-error">{error}</p>}
      </div>
    </div>
  )
}
