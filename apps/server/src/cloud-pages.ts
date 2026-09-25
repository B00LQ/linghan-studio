/**
 * 服务器端（cloud 模式）的页面：主页画廊、作品页、管理后台。
 *
 * 为什么是服务端渲染的 HTML 而不是那个 React 画布 SPA：
 * 这三页是**公开的展示面**（别人打开链接就该看到内容），不需要登录、不需要几百 KB 的 JS，
 * 而且搜索引擎与聊天软件的预览卡片都能直接读到标题与封面 —— 这是分享的前提。
 * 账号页（`accountPage`）与授权页同理，都在 `index.ts` 里。
 *
 * 三页共用一套外壳（颜色、字体、卡片），所以这里先有 `pageShell`。
 */

/** 把用户可控文本塞进 HTML 之前转义。 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character] ?? character))
}

/** 三页共用的样式（跟着产品配色走）。 */
const SHELL_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0d12; color: #e8ecf4;
         font: 14px/1.7 system-ui, "Microsoft YaHei", sans-serif; }
  a { color: #9db8ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .top { display: flex; align-items: center; gap: 14px; padding: 14px 20px; border-bottom: 1px solid #1d2431; }
  .top .brand { font-weight: 700; letter-spacing: .04em; }
  .top .spacer { flex: 1; }
  .wrap { width: min(1100px, 100%); margin: 0 auto; padding: 20px; }
  .card { background: #141821; border: 1px solid #263041; border-radius: 14px; padding: 18px 20px; margin-bottom: 14px; }
  h1 { font-size: 20px; margin: 0 0 10px; }
  h2 { font-size: 15px; margin: 0 0 10px; }
  p { margin: 0 0 10px; }
  .muted { color: #8b97a8; font-size: 13px; }
  .ok { color: #7ad1a3; } .bad { color: #ff8f8f; }
  .tag { display: inline-block; font-size: 11px; padding: 1px 8px; border-radius: 999px;
         border: 1px solid #2c3648; color: #9aa7bb; margin-right: 6px; }
  .tag.ai { border-color: #3a4a6b; color: #9db8ff; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
  .work { background: #141821; border: 1px solid #263041; border-radius: 12px; overflow: hidden; }
  .work .thumb { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; display: block; background: #0b0d12; }
  .work .body { padding: 10px 12px; }
  .work .title { font-weight: 600; display: block; margin-bottom: 4px; }
  button { padding: 8px 14px; border: 0; border-radius: 8px; background: #7aa2ff; color: #0b0d12;
           font-size: 13px; font-weight: 600; cursor: pointer; }
  button.ghost { background: transparent; color: #8b97a8; border: 1px solid #263041; font-weight: 400; }
  button.danger { background: transparent; color: #ff8f8f; border: 1px solid #3a2530; font-weight: 400; }
  input, textarea { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid #263041;
                    background: #0b0d12; color: #e8ecf4; font-size: 13px; margin-bottom: 8px; }
  .stage { background: #0b0d12; border: 1px solid #263041; border-radius: 12px; padding: 10px; text-align: center; }
  .stage img, .stage video { max-width: 100%; max-height: 70vh; border-radius: 8px; }
  .snapshot { border-top: 1px solid #1d2431; margin-top: 12px; padding-top: 12px; }
  .node { display: flex; gap: 10px; padding: 8px 0; border-top: 1px solid #1a2130; }
  .node:first-child { border-top: 0; }
  .node .who { flex: 0 0 150px; color: #8b97a8; font-size: 12px; }
  .node .what { flex: 1; min-width: 0; }
  .node img { max-width: 190px; border-radius: 8px; display: block; margin-top: 6px; }
  .edges { font-size: 12px; color: #8b97a8; white-space: pre-wrap; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #1d2431; vertical-align: top; }
  th { color: #8b97a8; font-weight: 600; }
  .row-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .empty { color: #8b97a8; padding: 30px 0; text-align: center; }
`

/**
 * 页面外壳。
 * @param title - 标题（也进 `<title>`，分享到聊天里就是它）。
 * @param body - 正文（**调用方负责转义**）。
 * @param options - 右上角的入口与 OG 卡片信息。
 * @returns 完整的 HTML。
 */
export function pageShell(title: string, body: string, options: {
  /** 右上角那句「你是谁 / 登录」。 */
  who?: string
  /** 管理员才显示的入口。 */
  admin?: boolean
  /** 分享卡片用的封面图（绝对或相对地址）。 */
  ogImage?: string
  /** 分享卡片用的一句话。 */
  ogDescription?: string
} = {}): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)} · LINGHAN Studio</title>
${options.ogImage === undefined ? '' : `<meta property="og:image" content="${escapeHtml(options.ogImage)}" />`}
<meta property="og:title" content="${escapeHtml(title)}" />
${options.ogDescription === undefined ? '' : `<meta property="og:description" content="${escapeHtml(options.ogDescription)}" />`}
<style>${SHELL_CSS}</style></head>
<body>
  <div class="top">
    <a class="brand" href="/">LINGHAN Studio</a>
    <span class="muted">作品广场</span>
    <span class="spacer"></span>
    ${options.admin === true ? '<a href="/admin">管理后台</a>' : ''}
    <span class="muted">${options.who ?? ''}</span>
  </div>
  <div class="wrap">${body}</div>
</body></html>`
}

/** 一件作品在页面上的样子（画廊卡片 / 列表行共用的一份数据）。 */
export interface WorkCard {
  id: string
  title: string
  summary: string
  tags: string
  kind: string
  author: string
  coverUrl: string
  status: string
  createdAt: string
}

/** 画廊卡片。 */
const workCard = (work: WorkCard): string => `
  <a class="work" href="/w/${encodeURIComponent(work.id)}">
    ${work.kind === 'video'
      ? `<video class="thumb" src="${escapeHtml(work.coverUrl)}" muted playsinline preload="metadata"></video>`
      : `<img class="thumb" src="${escapeHtml(work.coverUrl)}" alt="${escapeHtml(work.title)}" loading="lazy" />`}
    <div class="body">
      <span class="title">${escapeHtml(work.title)}</span>
      <span class="muted">${escapeHtml(work.author)}</span>
      <div>${work.tags.split(',').filter((tag) => tag.trim() !== '').slice(0, 3)
        .map((tag) => `<span class="tag">${escapeHtml(tag.trim())}</span>`).join('')}</div>
    </div>
  </a>`

/**
 * 主页：作品广场（**只展示审核通过的**）。
 * @param works - 已通过的作品。
 * @param viewer - 当前登录者的邮箱（空 = 没登录）。
 * @param isAdmin - 是不是管理员（决定是否显示后台入口）。
 * @returns 完整的 HTML。
 */
export function galleryPage(works: WorkCard[], viewer: string, isAdmin: boolean): string {
  const list = works.length === 0
    ? '<p class="empty">还没有作品。桌面端发布、管理员审核通过之后会出现在这里。</p>'
    : `<div class="grid">${works.map(workCard).join('')}</div>`
  return pageShell('作品广场', `
    <div class="card">
      <h1>作品广场</h1>
      <p class="muted">
        这里的每一件都是别人用桌面端做出来的成品；点开能看到成品，还能「查看画布」学习它是怎么搭的。
        发布与审核由作者与管理员完成 —— 主页只展示审核通过的作品。
      </p>
      ${viewer === '' ? '<p class="muted"><a href="/account">登录 / 注册</a></p>' : ''}
    </div>
    ${list}`, { who: viewer, admin: isAdmin, ogDescription: 'AI 作品广场 · 点开还能看画布' })
}

/** 只读画布快照里一个节点。 */
export interface SnapshotNode {
  id: string
  kind: string
  title: string
  text: string
  /** 节点上那张图/视频的公开地址（已经映射成服务器上的压缩版）；空 = 没有画面。 */
  url: string
}

/** 只读画布快照：节点 + 连线（文字形式）。 */
export interface SnapshotView {
  nodes: SnapshotNode[]
  edges: { from: string; to: string; port: string }[]
}

/**
 * 作品页：成品 + 作者 + 「查看画布」。
 * @param work - 作品数据（**只有 approved 或作者/管理员才该看到这个页面**）。
 * @param assetUrl - 成品的公开地址。
 * @param snapshot - 只读画布快照；空 = 这件作品没带画布。
 * @param options - 状态提示（待审/被拒/下架）、举报入口、是不是作者。
 * @returns 完整的 HTML。
 */
export function workPage(work: WorkCard, assetUrl: string, snapshot: SnapshotView | null, options: {
  /** 状态提示（作者或管理员看得到）。 */
  notice?: string
  /** 要不要显示举报入口。 */
  reportable?: boolean
} = {}): string {
  const stages = work.kind === 'video'
    ? `<video src="${escapeHtml(assetUrl)}" controls playsinline preload="metadata"></video>`
    : `<img src="${escapeHtml(assetUrl)}" alt="${escapeHtml(work.title)}" />`
  const snapshotHtml = snapshot === null
    ? '<p class="muted">这件作品没有附带画布。</p>'
    : `
      <div class="snapshot">
        ${snapshot.nodes.map((node) => `
          <div class="node">
            <div class="who">${escapeHtml(node.title)}<br /><span class="muted">${escapeHtml(node.kind)}</span></div>
            <div class="what">
              ${node.text === '' ? '<span class="muted">（这个节点没有提示词）</span>' : escapeHtml(node.text)}
              <div class="muted">${escapeHtml(node.id)}</div>
              ${node.url === '' ? '' : `<img src="${escapeHtml(node.url)}" alt="" loading="lazy" />`}
            </div>
          </div>`).join('')}
        <h2 style="margin-top:14px">连线</h2>
        <div class="edges">${snapshot.edges.length === 0 ? '（没有连线）' : escapeHtml(snapshot.edges.map((edge) => `${edge.from} → ${edge.to}（${edge.port}）`).join('\n'))}</div>
      </div>`
  return pageShell(work.title, `
    <div class="card">
      <h1>${escapeHtml(work.title)}</h1>
      <p class="muted">
        ${escapeHtml(work.author)} · ${new Date(work.createdAt.replace('T', ' ')).toLocaleString('zh-CN')}
        · <span class="tag ai">AI 生成</span>
        ${work.tags.split(',').filter((tag) => tag.trim() !== '').map((tag) => `<span class="tag">${escapeHtml(tag.trim())}</span>`).join('')}
      </p>
      ${work.summary === '' ? '' : `<p>${escapeHtml(work.summary)}</p>`}
      ${options.notice === undefined || options.notice === '' ? '' : `<p class="muted">${escapeHtml(options.notice)}</p>`}
      <div class="stage">${stages}</div>
      <div class="row-actions" style="margin-top:12px">
        <button class="ghost" id="toggle-canvas">查看画布</button>
        ${options.reportable === true ? '<button class="danger" id="report">举报</button>' : ''}
      </div>
      <div id="canvas-box" style="display:none">${snapshotHtml}</div>
      <p class="muted" id="note" style="margin-top:10px"></p>
    </div>
    <script>
      const $ = (id) => document.getElementById(id);
      $('toggle-canvas').addEventListener('click', () => {
        const box = $('canvas-box');
        const open = box.style.display !== 'none';
        box.style.display = open ? 'none' : 'block';
        $('toggle-canvas').textContent = open ? '查看画布' : '收起画布';
      });
      ${options.reportable === true ? `
      $('report').addEventListener('click', async () => {
        const reason = window.prompt('举报理由（例如：不是自己做的 / 内容不合适）');
        if (!reason) return;
        const response = await fetch('/api/v1/works/${encodeURIComponent(work.id)}/report', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }),
        });
        $('note').textContent = response.ok ? '已经收到举报，管理员会看。' : '举报没提交成功，稍后再试。';
      });` : ''}
    </script>`, {
    who: '',
    ogImage: assetUrl,
    ogDescription: work.summary === '' ? `${work.author} 的作品` : work.summary,
  })
}

/**
 * 管理后台：待审队列 + 作品管理 + 举报。
 *
 * **这是「必须我确认才上主页」那条要求的落点**：所有审核动作都在这一页，
 * 页面上的数据靠 `/api/v1/admin/*` 拿（服务端校验角色），所以后台既不泄露给别人，
 * 也不用为它单独做一个应用。
 * @returns 完整的 HTML。
 */
export function adminPage(): string {
  return pageShell('管理后台', `
    <div class="card">
      <h1>管理后台</h1>
      <p class="muted">作品必须在这里点「通过」才会出现在主页。拒绝要填理由（作者看得到）。</p>
      <div class="row-actions">
        <button class="ghost" data-tab="pending">待审</button>
        <button class="ghost" data-tab="approved">已发布</button>
        <button class="ghost" data-tab="rejected">已拒绝</button>
        <button class="ghost" data-tab="hidden">已下架</button>
        <button class="ghost" data-tab="reports">举报</button>
      </div>
    </div>
    <div class="card"><div id="list"><p class="muted">正在读…</p></div></div>
    <script>
      const $ = (id) => document.getElementById(id);
      const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const api = async (path, init = {}) => {
        const response = await fetch('/api/v1' + path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
        return { ok: response.ok, status: response.status, body: await response.json().catch(() => ({})) };
      };
      const review = async (id, status) => {
        let note = '';
        if (status === 'rejected' || status === 'hidden') {
          note = window.prompt(status === 'rejected' ? '拒绝理由（作者会看到）' : '下架原因', '') ?? '';
          if (note === '') return;
        }
        const { ok, body } = await api('/admin/works/' + id + '/review', { method: 'POST', body: JSON.stringify({ status, note }) });
        if (!ok) { window.alert(body.error || '操作失败'); return; }
        void load(tab);
      };
      let tab = 'pending';
      const load = async (next) => {
        tab = next;
        if (tab === 'reports') {
          const { body } = await api('/admin/reports');
          const rows = body.reports ?? [];
          $('list').innerHTML = rows.length === 0 ? '<p class="empty">没有举报。</p>' : '<table><thead><tr><th>作品</th><th>理由</th><th>时间</th><th>状态</th><th></th></tr></thead><tbody>' +
            rows.map((item) => '<tr><td><a href="/w/' + escape(item.workId) + '">' + escape(item.workId.slice(0, 8)) + '</a></td><td>' + escape(item.reason) + '</td><td>' + escape(item.createdAt.slice(0, 16).replace('T', ' ')) + '</td><td>' + escape(item.status) + '</td><td>' +
              (item.status === 'open' ? '<div class="row-actions"><button class="danger" data-hide="' + escape(item.workId) + '">下架并处理</button><button class="ghost" data-handle="' + escape(item.id) + '">仅标记处理</button></div>' : '已处理') +
              '</td></tr>').join('') + '</tbody></table>';
          for (const button of document.querySelectorAll('[data-handle]')) {
            button.addEventListener('click', async () => { await api('/admin/reports/' + button.getAttribute('data-handle') + '/handle', { method: 'POST', body: '{}' }); void load('reports'); });
          }
          for (const button of document.querySelectorAll('[data-hide]')) {
            button.addEventListener('click', async () => {
              const note = window.prompt('下架原因', '举报处理') ?? '';
              await api('/admin/works/' + button.getAttribute('data-hide') + '/review', { method: 'POST', body: JSON.stringify({ status: 'hidden', note }) });
              void load('reports');
            });
          }
          return;
        }
        const { body } = await api('/admin/works?status=' + tab);
        const works = body.works ?? [];
        $('list').innerHTML = works.length === 0 ? '<p class="empty">这个分类下没有作品。</p>' : '<table><thead><tr><th>作品</th><th>作者</th><th>状态</th><th>提交时间</th><th>操作</th></tr></thead><tbody>' +
          works.map((work) => '<tr><td><a href="/w/' + escape(work.id) + '" target="_blank">' + escape(work.title) + '</a><br /><span class="muted">' + escape(work.kind) + (work.hasSnapshot ? ' · 带画布' : '') + '</span></td><td>' + escape(work.author) + '</td><td>' + escape(work.status) + (work.reviewNote ? '<br /><span class="muted">' + escape(work.reviewNote) + '</span>' : '') + '</td><td>' + escape(work.createdAt.slice(0, 16).replace('T', ' ')) + '</td><td><div class="row-actions">' +
            (work.status === 'pending' ? '<button data-ok="' + escape(work.id) + '">通过</button><button class="danger" data-no="' + escape(work.id) + '">拒绝</button>' : '') +
            (work.status === 'approved' ? '<button class="danger" data-no="' + escape(work.id) + '">下架</button>' : '') +
            (work.status === 'rejected' || work.status === 'hidden' ? '<button data-ok="' + escape(work.id) + '">放行</button>' : '') +
            '</div></td></tr>').join('') + '</tbody></table>';
        for (const button of document.querySelectorAll('[data-ok]')) {
          button.addEventListener('click', () => { void review(button.getAttribute('data-ok'), 'approved') });
        }
        for (const button of document.querySelectorAll('[data-no]')) {
          button.addEventListener('click', () => { void review(button.getAttribute('data-no'), tab === 'approved' ? 'hidden' : 'rejected') });
        }
      };
      for (const button of document.querySelectorAll('[data-tab]')) {
        button.addEventListener('click', () => { void load(button.getAttribute('data-tab')) });
      }
      void load('pending');
    </script>`, { who: '管理员', admin: true })
}

/**
 * 把画布快照里的节点整理成「人看得懂的学习材料」。
 *
 * 快照是**发布时**生成的只读 JSON：节点结构、提示词、参数都在，
 * 图片已经换成了服务器上的压缩版地址（本地原图永远不上传）。
 * @param snapshot - 发布时存的快照 JSON 文本。
 * @returns 节点与连线，或 null（没带画布 / 快照读不出来）。
 */
export function readSnapshot(snapshot: string): SnapshotView | null {
  if (snapshot.trim() === '') return null
  try {
    const doc = JSON.parse(snapshot) as {
      nodes?: { id?: unknown; data?: Record<string, unknown> }[]
      edges?: { source?: unknown; target?: unknown; targetHandle?: unknown }[]
    }
    const nodes = (doc.nodes ?? []).flatMap((node) => {
      const data = node.data ?? {}
      const kind = typeof data.kind === 'string' ? data.kind : 'node'
      const id = typeof node.id === 'string' ? node.id : ''
      if (id === '') return []
      const text = typeof data.text === 'string' ? data.text : ''
      const url = typeof data.url === 'string' ? data.url : ''
      // 组框之类的节点没有内容，读起来只是噪音 —— 但保留它们能说明布局，所以留下、只标出来。
      return [{ id, kind, title: typeof data.name === 'string' && data.name !== '' ? data.name : kind, text, url }]
    })
    const edges = (doc.edges ?? []).flatMap((edge) => {
      const from = typeof edge.source === 'string' ? edge.source : ''
      const to = typeof edge.target === 'string' ? edge.target : ''
      if (from === '' || to === '') return []
      return [{ from, to, port: typeof edge.targetHandle === 'string' && edge.targetHandle !== '' ? edge.targetHandle : '默认' }]
    })
    return { nodes, edges }
  } catch {
    return null
  }
}
