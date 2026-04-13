import { useState, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import DOMPurify from 'dompurify';

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  height?: number;
  placeholder?: string;
  id?: string;
  'aria-label'?: string;
}

export default function MarkdownEditor({ value, onChange, height = 200, placeholder, id, 'aria-label': ariaLabel }: MarkdownEditorProps) {
  const [showPreview, setShowPreview] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const target = e.target as HTMLTextAreaElement;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const newValue = value.substring(0, start) + '  ' + value.substring(end);
      onChange(newValue);
      setTimeout(() => {
        target.selectionStart = target.selectionEnd = start + 2;
      }, 0);
    }
  }, [value, onChange]);

  const renderMarkdown = (text: string) => {
    const sanitized = DOMPurify.sanitize(text);
    return sanitized;
  };

  const panelHeight = height;

  return (
    <div className="flex flex-col border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1.5 bg-zinc-50 dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setShowPreview(false)}
            className={`px-2 py-1 text-xs rounded ${
              !showPreview 
                ? 'bg-blue-500 text-white' 
                : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
            }`}
          >
            编辑
          </button>
          <button
            type="button"
            onClick={() => setShowPreview(true)}
            className={`px-2 py-1 text-xs rounded ${
              showPreview 
                ? 'bg-blue-500 text-white' 
                : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
            }`}
          >
            预览
          </button>
        </div>
        {showPreview && (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">Markdown 实时预览</span>
        )}
      </div>
      
      {showPreview ? (
        <div 
          className="overflow-auto p-3 bg-white dark:bg-zinc-900 prose prose-sm dark:prose-invert max-w-none"
          style={{ height: panelHeight }}
        >
          {value ? (
            <ReactMarkdown rehype-sanitize>{renderMarkdown(value)}</ReactMarkdown>
          ) : (
            <p className="text-zinc-400 dark:text-zinc-500 italic">暂无内容</p>
          )}
        </div>
      ) : (
        <textarea
          ref={textareaRef}
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className="w-full px-3 py-2 font-mono text-sm resize-none focus:outline-none bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500"
          style={{ height: panelHeight }}
        />
      )}
    </div>
  );
}