/**
 * dsh-search-picture —— Client 半：`search_picture` 的工具结果卡片。
 *
 * 形态：`dsh.client` web bundle（`window.__ModuleLoader__.load` 注册的惰性工厂，
 * id 必须等于包名）。只依赖模块表里的基线 `react`，不 import 任何 Client 包，
 * 因此 DSH 升级时受影响的面最小。
 *
 * 机制：向 `tool.call.toolview` 注册 key=`search_picture` 的视图，数据全部来自
 * Host 半写进 `tool/result.meta` 的展示元数据（`presentationMeta`），不去解析
 * 模型可见的文本。缩略图通过 owner 提供的 `loadImage(attachment)` 取得会话授权的
 * 图片 URL（该 loader 由 Chat 注入，视图自己不管理附件 URL）。
 *
 * 样式只用主题 token（`--dsw-alias-*` / `--dsw-radius-*`），自动跟随明暗主题。
 */
window.__ModuleLoader__.load({
  id: 'dsh-search-picture',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef } = React;

    /** 视图文案（跟随 GUI 语言）。 */
    const DICT = {
      zh: {
        searching: '正在搜索并下载图片…',
        empty: '没有找到符合清晰度要求的图片。',
        images: (n) => `${String(n)} 张`,
        into: '保存到',
        noPreview: '不可预览',
        title: '搜索图片',
        clickHint: '点击缩略图可放大预览',
        previewHint: '以上是候选，确认满意后才移入正式文件夹',
        saveTitle: '保存图片',
        saving: '正在移入正式文件夹…',
        savedCount: (n) => `已保存 ${String(n)} 张`,
        nothingSaved: '没有任何图片进入正式文件夹',
        discarded: (n) => `已丢弃 ${String(n)} 张`,
      },
      en: {
        searching: 'Searching and downloading images…',
        empty: 'No images met the resolution requirement.',
        images: (n) => `${String(n)} image${n === 1 ? '' : 's'}`,
        into: 'saved to',
        noPreview: 'no preview',
        title: 'Picture search',
        clickHint: 'Click a thumbnail to enlarge',
        previewHint: 'Candidates only — nothing is saved until you confirm',
        saveTitle: 'Save pictures',
        saving: 'Moving into the target folder…',
        savedCount: (n) => `${String(n)} saved`,
        nothingSaved: 'No image was saved',
        discarded: (n) => `${String(n)} discarded`,
      },
    };

    /** 读取当前语言（locale 服务缺失时默认中文）。 */
    function resolveLang(ctx) {
      try {
        const locale = ctx.get('locale');
        const snapshot = locale !== undefined && typeof locale.getLocale === 'function' ? locale.getLocale() : undefined;
        const id = typeof snapshot === 'string' ? snapshot : snapshot !== null && snapshot !== undefined && typeof snapshot.id === 'string' ? snapshot.id : '';
        return id.toLowerCase().startsWith('en') ? 'en' : 'zh';
      } catch {
        return 'zh';
      }
    }

    /**
     * 从工具结果的展示元数据里取出图片清单，逐项校验字段。
     * 元数据可能在窗口截断重放中缺失或损坏，因此凡是形状不对就退化为通用卡片。
     * @param meta `tool/result` 事件的 meta。
     * @returns 校验后的条目数组，或 null。
     */
    function readImages(meta) {
      if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null;
      const images = meta.images;
      if (!Array.isArray(images)) return null;
      const out = [];
      for (const entry of images) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
        const attachment = entry.attachment;
        const usable =
          typeof attachment === 'object'
          && attachment !== null
          && typeof attachment.attachmentId === 'string'
          && typeof attachment.mediaType === 'string';
        out.push({
          path: typeof entry.path === 'string' ? entry.path : '',
          fileName: typeof entry.fileName === 'string' ? entry.fileName : '',
          width: typeof entry.width === 'number' ? entry.width : undefined,
          height: typeof entry.height === 'number' ? entry.height : undefined,
          bytes: typeof entry.bytes === 'number' ? entry.bytes : undefined,
          engine: typeof entry.engine === 'string' ? entry.engine : '',
          sourceUrl: typeof entry.sourceUrl === 'string' ? entry.sourceUrl : undefined,
          pageUrl: typeof entry.pageUrl === 'string' ? entry.pageUrl : undefined,
          attachment: usable ? attachment : undefined,
        });
      }
      return {
        query: typeof meta.query === 'string' ? meta.query : '',
        directory: typeof meta.directory === 'string' ? meta.directory : '',
        images: out,
      };
    }

    /** 取工具调用的查询词（准备/运行阶段的卡片标题用）。 */
    function readQuery(block) {
      const args = block?.args ?? block?.arguments;
      return typeof args?.query === 'string' ? args.query : '';
    }

    /**
     * 读取 `save_pictures` 的展示元数据：进了哪个文件夹、哪些文件、丢弃了哪些。
     * 形状不对就退化为通用卡片（窗口截断重放时元数据可能缺失）。
     * @param meta `tool/result` 事件的 meta。
     * @returns 校验后的对象，或 null。
     */
    function readPromotion(meta) {
      if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null;
      if (typeof meta.targetFolder !== 'string' || !Array.isArray(meta.saved)) return null;
      const saved = [];
      for (const entry of meta.saved) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
        if (typeof entry.fileName !== 'string') return null;
        saved.push({
          fileName: entry.fileName,
          path: typeof entry.path === 'string' ? entry.path : '',
          bytes: typeof entry.bytes === 'number' ? entry.bytes : undefined,
        });
      }
      return {
        folderName: typeof meta.folderName === 'string' ? meta.folderName : '',
        targetFolder: meta.targetFolder,
        saved,
        discarded: Array.isArray(meta.discarded) ? meta.discarded.filter((name) => typeof name === 'string') : [],
      };
    }

    /** 字节数的人类可读形式。 */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '';
      if (bytes < 1024) return `${String(bytes)} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    /** 缩略图：自己加载 URL，失败时就地显示占位。 */
    function Thumbnail({ image, loadImage, onOpen, label }) {
      const [url, setUrl] = useState(null);
      const [failed, setFailed] = useState(false);

      useEffect(() => {
        let live = true;
        setUrl(null);
        setFailed(false);
        if (image.attachment === undefined || typeof loadImage !== 'function') {
          setFailed(true);
          return () => {};
        }
        Promise.resolve(loadImage(image.attachment))
          .then((resolved) => {
            if (live) setUrl(typeof resolved === 'string' ? resolved : null);
          })
          .catch(() => {
            if (live) setFailed(true);
          });
        return () => {
          live = false;
        };
      }, [image.attachment, loadImage]);

      const meta = [
        image.width !== undefined && image.height !== undefined ? `${String(image.width)}x${String(image.height)}` : '',
        formatBytes(image.bytes),
        image.engine,
      ].filter((part) => part !== '').join(' · ');

      // 悬停提示里带上直链与来源页：用户问「这图哪来的」时，卡片本身就能回答。
      const tooltip = [
        image.fileName,
        meta,
        image.sourceUrl === undefined ? '' : `直链 ${image.sourceUrl}`,
        image.pageUrl === undefined ? '' : `出处 ${image.pageUrl}`,
      ].filter((line) => line !== '').join('\n');

      return h('button', {
        type: 'button',
        title: tooltip,
        onClick: onOpen,
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          width: 108,
          padding: 0,
          border: 'none',
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          textAlign: 'left',
          cursor: url === null ? 'default' : 'zoom-in',
        },
      }, [
        h('div', {
          key: 'frame',
          style: {
            width: 108,
            height: 108,
            display: 'grid',
            placeItems: 'center',
            overflow: 'hidden',
            border: '0.5px solid var(--dsw-alias-border-l2-darkmode-thin, rgba(0,0,0,0.12))',
            borderRadius: 'var(--dsw-radius-xl, 12px)',
            background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08))',
          },
        }, url !== null
          ? h('img', { src: url, alt: image.fileName, loading: 'lazy', style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' } })
          : h('span', { style: { fontSize: 11, lineHeight: '14px', color: 'var(--dsw-alias-label-tertiary, #888)', padding: 4, textAlign: 'center' } }, failed ? label : '…')),
        h('span', {
          key: 'meta',
          style: { fontSize: 11, lineHeight: '14px', color: 'var(--dsw-alias-label-tertiary, #888)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
        }, meta),
      ]);
    }

    /**
     * 全屏预览：点击遮罩或 Esc 关闭，并显示这张图的本地路径、直链与来源页。
     * 直链与来源页是链接，点开就等于回答「这图到底从哪来」。
     */
    function Lightbox({ src, alt, path, sourceUrl, pageUrl, onClose, labels }) {
      useEffect(() => {
        if (src === null) return () => {};
        const onKey = (event) => {
          if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('keydown', onKey);
        };
      }, [src, onClose]);

      if (src === null) return null;
      const line = { fontSize: 12, color: '#fff', opacity: 0.85, wordBreak: 'break-all', maxWidth: '92vw', textAlign: 'center' };
      return h('div', {
        onClick: onClose,
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          padding: 24,
          background: 'var(--dsw-alias-bg-mask-drop, rgba(0,0,0,0.72))',
          cursor: 'zoom-out',
        },
      }, [
        h('img', {
          key: 'img',
          src,
          alt,
          style: { maxWidth: '92vw', maxHeight: '76vh', objectFit: 'contain', borderRadius: 'var(--dsw-radius-lg, 8px)' },
        }),
        h('div', { key: 'path', style: line }, path === '' ? labels : path),
        sourceUrl === undefined ? null : h('a', {
          key: 'src',
          href: sourceUrl,
          target: '_blank',
          rel: 'noreferrer',
          // 遮罩点击负责关闭，链接自己的点击不能被它吞掉。
          onClick: (event) => { event.stopPropagation(); },
          style: { ...line, opacity: 1, color: '#bfd7ff', cursor: 'pointer' },
        }, `图片直链 ↗`),
        pageUrl === undefined ? null : h('a', {
          key: 'page',
          href: pageUrl,
          target: '_blank',
          rel: 'noreferrer',
          onClick: (event) => { event.stopPropagation(); },
          style: { ...line, color: '#bfd7ff', cursor: 'pointer' },
        }, `来源页面 ↗`),
      ]);
    }

    /**
     * `save_pictures` 的对话行：确认入库的结果（进了哪个文件夹、哪些文件、丢弃了哪些）。
     * @param props owner 提供的标准 props（`block`、`toolName`）。
     */
    function SavePicturesRow(props) {
      const { block, toolName } = props;
      const L = DICT[props.__lang] ?? DICT.zh;
      const promotion = readPromotion(block?.meta);
      const args = block?.args ?? block?.arguments;
      const folder = promotion?.folderName ?? (typeof args?.folder === 'string' ? args.folder : '');

      const header = [folder === '' ? L.saveTitle : folder];
      if (promotion !== null) header.push(L.savedCount(promotion.saved.length));

      const rows = promotion === null ? [] : promotion.saved.map((entry, index) => h('div', {
        key: entry.path === '' ? `${entry.fileName}:${String(index)}` : entry.path,
        style: { display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 0' },
      }, [
        h('span', { key: 'name', style: { fontSize: 12, color: 'var(--dsw-alias-label-primary)' } },
          `${String(index + 1)}. ${entry.fileName}${entry.bytes === undefined ? '' : ` · ${formatBytes(entry.bytes)}`}`),
        entry.path === '' ? null : h('span', {
          key: 'path',
          style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #888)', wordBreak: 'break-all' },
        }, entry.path),
      ]));

      return h('div', { 'data-tool': toolName, style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '2px 0' } }, [
        h('div', {
          key: 'header',
          style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' },
        }, header.map((text, index) => h('span', {
          key: `${String(index)}:${text}`,
          style: index === 0 ? { fontWeight: 500 } : { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)' },
        }, text))),
        promotion === null
          ? h('div', { key: 'running', style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)' } }, L.saving)
          : rows.length === 0
            ? h('div', { key: 'empty', style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)' } }, L.nothingSaved)
            : h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column' } }, rows),
        promotion !== null && promotion.targetFolder !== ''
          ? h('div', {
            key: 'folder',
            style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #888)', wordBreak: 'break-all' },
          }, `${L.into} ${promotion.targetFolder}`)
          : null,
        promotion !== null && promotion.discarded.length > 0
          ? h('div', {
            key: 'discarded',
            style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #888)' },
          }, L.discarded(promotion.discarded.length))
          : null,
      ]);
    }

    /**
     * `search_picture` 的对话行：标题 + 缩略图画廊。
     * @param props owner 提供的标准 props（`block`、`phase`、`loadImage`、`toolName`）。
     */
    function SearchPictureRow(props) {
      const { block, loadImage, toolName } = props;
      const L = DICT[props.__lang] ?? DICT.zh;
      const [zoom, setZoom] = useState(null);
      /** attachmentId → 已加载的图片 URL，供灯箱复用。 */
      const urlsRef = useRef({});

      const settled = readImages(block?.meta);
      const query = settled?.query ?? readQuery(block);
      const images = settled?.images ?? [];

      const header = [query === '' ? L.title : query];
      if (settled !== null && images.length > 0) header.push(L.images(images.length));
      if (settled !== null && settled.directory !== '') header.push(`${L.into} ${settled.directory}`);

      const load = typeof loadImage === 'function'
        ? (attachment) => Promise.resolve(loadImage(attachment)).then((url) => {
          if (typeof url === 'string' && typeof attachment?.attachmentId === 'string') urlsRef.current[attachment.attachmentId] = url;
          return url;
        })
        : undefined;

      const thumbnails = images.map((image, index) => h(Thumbnail, {
        key: image.attachment?.attachmentId ?? `${image.path}:${String(index)}`,
        image,
        loadImage: load,
        label: L.noPreview,
        onOpen: () => {
          const url = image.attachment === undefined ? undefined : urlsRef.current[image.attachment.attachmentId];
          if (url !== undefined) setZoom({ src: url, path: image.path, sourceUrl: image.sourceUrl, pageUrl: image.pageUrl });
        },
      }));

      return h('div', { 'data-tool': toolName, style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '2px 0' } }, [
        h('div', {
          key: 'header',
          style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' },
        }, header.map((text, index) => h('span', {
          key: `${String(index)}:${text}`,
          style: index === 0 ? { fontWeight: 500 } : { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)' },
        }, text))),
        settled === null
          ? h('div', { key: 'running', style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)' } }, L.searching)
          : images.length === 0
            ? h('div', { key: 'empty', style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)' } }, L.empty)
            : h('div', { key: 'gallery', style: { display: 'flex', flexWrap: 'wrap', gap: 10 } }, thumbnails),
        settled !== null && images.length > 0
          ? h('div', { key: 'hint', style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #888)' } }, `${L.previewHint} · ${L.clickHint}`)
          : null,
        h(Lightbox, {
          key: 'zoom',
          src: zoom?.src ?? null,
          alt: zoom?.path ?? '',
          path: zoom?.path ?? '',
          sourceUrl: zoom?.sourceUrl,
          pageUrl: zoom?.pageUrl,
          labels: L.title,
          onClose: () => { setZoom(null); },
        }),
      ]);
    }

    return {
      name: 'dsh-search-picture-client',
      inject: ['slots'],
      /**
       * 注册 `search_picture` 的对话行。
       * @param ctx Client 插件上下文。
       */
      apply(ctx) {
        const lang = resolveLang(ctx);
        const View = (props) => h(SearchPictureRow, { ...props, __lang: lang });
        const SaveView = (props) => h(SavePicturesRow, { ...props, __lang: lang });
        ctx.slots.inject('tool.call.toolview', function* registerRows() {
          yield ctx.slots.register({
            name: 'tool.call.toolview',
            key: 'search_picture',
            locale: 'conversation',
          }, View);
          yield ctx.slots.register({
            name: 'tool.call.toolview',
            key: 'save_pictures',
            locale: 'conversation',
          }, SaveView);
        });
      },
    };
  },
});
