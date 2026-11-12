import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useT } from './i18n/index.ts';
import { imageHost } from './markdown-image.ts';

const SAFE_PROTOCOLS = /^(https?:|mailto:|#|\/)/i;

// 同じ文なら描き直さない（流れている返事の描き直しを、呼ぶ側が間引けるように）
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const t = useT();
  return (
    <div className="ui-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={url => (SAFE_PROTOCOLS.test(url) ? url : '')}
        components={{
          a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
          img: ({ alt, src }) => {
            const label = alt || t('markdown.imageHidden');
            const host = imageHost(src);
            return <span className="ui-md__note">{host ? t('markdown.imageFrom', label, host) : t('markdown.image', label)}</span>;
          },
          table: ({ children }) => <div className="ui-md__table"><table>{children}</table></div>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
