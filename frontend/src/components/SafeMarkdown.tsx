import ReactMarkdown from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

interface SafeMarkdownProps {
  children: string;
  className?: string;
}

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames || []),
    'img',
  ],
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] || []), 'className'],
    img: ['src', 'alt', 'title', 'className'],
    a: ['href', 'title', 'className'],
  },
  clobberPrefix: 'safe-',
  clobber: ['ariaDescribedBy', 'ariaLabelledBy', 'id', 'name'],
  ancestors: {
    ...defaultSchema.ancestors,
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https', 'data'],
  },
  strip: ['script', 'style', 'iframe', 'form', 'input', 'button', 'select', 'textarea', 'object', 'embed'],
};

export function SafeMarkdown({ children, className }: SafeMarkdownProps) {
  const content = typeof children === 'string' ? children : '';
  
  const sanitizedContent = content
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/javascript:/gi, 'javascript-disabled:')
    .replace(/data:/gi, 'data-disabled:');
  
  return className ? (
    <div className={className}>
      <ReactMarkdown rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}>
        {sanitizedContent}
      </ReactMarkdown>
    </div>
  ) : (
    <ReactMarkdown rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}>
      {sanitizedContent}
    </ReactMarkdown>
  );
}
