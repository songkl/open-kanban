import ReactMarkdown from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeRaw from 'rehype-raw';

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
  clobberPrefix: '',
  clobber: false,
  ancestors: {
    ...defaultSchema.ancestors,
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https', 'data'],
  },
};

interface SafeMarkdownProps {
  children: string;
  className?: string;
}

export function SafeMarkdown({ children, className }: SafeMarkdownProps) {
  return className ? (
    <div className={className}>
      <ReactMarkdown rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}>
        {children}
      </ReactMarkdown>
    </div>
  ) : (
    <ReactMarkdown rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}>
      {children}
    </ReactMarkdown>
  );
}