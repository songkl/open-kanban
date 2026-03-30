import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Attachment } from '@/types/kanban';

interface AttachmentListProps {
  attachments: Attachment[];
  onDelete?: (id: string) => void;
  canDelete?: boolean;
}

export function AttachmentList({
  attachments,
  onDelete,
  canDelete = true,
}: AttachmentListProps) {
  const { t } = useTranslation();
  const [previewImage, setPreviewImage] = useState<Attachment | null>(null);

  if (!attachments || attachments.length === 0) {
    return null;
  }

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const isImage = (mimeType: string): boolean => {
    return mimeType?.startsWith('image/') ?? false;
  };

  const getFileIcon = (mimeType: string) => {
    if (mimeType?.startsWith('image/')) {
      return (
        <svg className="h-6 w-6 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      );
    }
    if (mimeType?.includes('pdf')) {
      return (
        <svg className="h-6 w-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
        </svg>
      );
    }
    if (mimeType?.includes('word') || mimeType?.includes('document')) {
      return (
        <svg className="h-6 w-6 text-blue-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      );
    }
    if (mimeType?.includes('excel') || mimeType?.includes('sheet')) {
      return (
        <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      );
    }
    return (
      <svg className="h-6 w-6 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
      </svg>
    );
  };

  const handleDownload = (attachment: Attachment) => {
    const link = document.createElement('a');
    link.href = attachment.url;
    link.download = attachment.filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handlePreview = (attachment: Attachment) => {
    if (isImage(attachment.mimeType)) {
      setPreviewImage(attachment);
    } else {
      // Open non-image files in new tab
      window.open(attachment.url, '_blank');
    }
  };

  return (
    <div className="w-full">
      {/* Attachment Grid */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {attachments.map((attachment) => (
          <div
            key={attachment.id}
            className="group flex items-center gap-3 rounded-lg border border-zinc-200 bg-white p-3 hover:border-zinc-300 hover:shadow-sm transition-all"
          >
            {/* Thumbnail / Icon */}
            <div
              className="flex-shrink-0 cursor-pointer"
              onClick={() => handlePreview(attachment)}
            >
              {isImage(attachment.mimeType) ? (
                <div className="h-12 w-12 overflow-hidden rounded-lg bg-zinc-100">
                  <img
                    src={attachment.url}
                    alt={attachment.filename}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                </div>
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-zinc-100">
                  {getFileIcon(attachment.mimeType)}
                </div>
              )}
            </div>

            {/* File Info */}
            <div className="min-w-0 flex-1">
              <div
                className="truncate text-sm font-medium text-zinc-700 cursor-pointer hover:text-blue-600"
                onClick={() => handlePreview(attachment)}
              >
                {attachment.filename}
              </div>
              <div className="text-xs text-zinc-500">
                {formatFileSize(attachment.size)}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              {/* Preview / Download Button */}
              <button
                onClick={() => handlePreview(attachment)}
                className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
                title={isImage(attachment.mimeType) ? t('attachment.preview') : t('attachment.open')}
              >
                {isImage(attachment.mimeType) ? (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                )}
              </button>

              {/* Download Button */}
              <button
                onClick={() => handleDownload(attachment)}
                className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
                title={t('attachment.download')}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </button>

              {/* Delete Button */}
              {canDelete && onDelete && (
                <button
                  onClick={() => onDelete(attachment.id)}
                  className="rounded p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-500"
                  title={t('attachment.delete')}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Image Preview Modal */}
      {previewImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
          onClick={() => setPreviewImage(null)}
        >
          <div className="relative max-h-[90vh] max-w-[90vw]">
            {/* Close Button */}
            <button
              onClick={() => setPreviewImage(null)}
              className="absolute -right-10 top-0 rounded-full p-2 text-white hover:bg-white/10"
            >
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            {/* Image */}
            <img
              src={previewImage.url}
              alt={previewImage.filename}
              className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
              onClick={(e) => e.stopPropagation()}
            />

            {/* Filename */}
            <div className="absolute bottom-0 left-0 right-0 rounded-b-lg bg-gradient-to-t from-black/60 to-transparent p-4">
              <p className="text-center text-sm text-white">{previewImage.filename}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
