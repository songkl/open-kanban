import { useState, useRef, useCallback } from 'react';
import { attachmentsApi } from '@/services/api';
import type { Attachment } from '@/types/kanban';

interface FileUploadProps {
  taskId?: string;
  commentId?: string;
  onUpload: (attachments: Attachment[]) => void;
  maxFiles?: number;
  accept?: string[];
  disabled?: boolean;
}

interface UploadingFile {
  id: string;
  file: File;
  progress: number;
  status: 'pending' | 'uploading' | 'success' | 'error';
  error?: string;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
];

export function FileUpload({
  taskId,
  commentId,
  onUpload,
  maxFiles = 10,
  accept,
  disabled = false,
}: FileUploadProps) {
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const validateFile = (file: File): string | null => {
    if (file.size > MAX_FILE_SIZE) {
      return '文件过大，最大支持 10MB';
    }
    if (!ALLOWED_TYPES.includes(file.type)) {
      return '不支持的文件类型';
    }
    return null;
  };

  const uploadFile = async (uploadingFile: UploadingFile) => {
    const { file } = uploadingFile;

    setUploadingFiles((prev) =>
      prev.map((f) =>
        f.id === uploadingFile.id ? { ...f, status: 'uploading' } : f
      )
    );

    try {
      const attachment = await attachmentsApi.upload(
        file,
        taskId,
        commentId,
        (progress) => {
          setUploadingFiles((prev) =>
            prev.map((f) =>
              f.id === uploadingFile.id ? { ...f, progress } : f
            )
          );
        }
      );

      setUploadingFiles((prev) =>
        prev.map((f) =>
          f.id === uploadingFile.id ? { ...f, status: 'success' } : f
        )
      );

      onUpload([attachment]);

      // Remove from list after a delay
      setTimeout(() => {
        setUploadingFiles((prev) => prev.filter((f) => f.id !== uploadingFile.id));
      }, 2000);
    } catch (error) {
      setUploadingFiles((prev) =>
        prev.map((f) =>
          f.id === uploadingFile.id
            ? { ...f, status: 'error', error: '上传失败' }
            : f
        )
      );
    }
  };

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || disabled) return;

      const fileArray = Array.from(files);
      const remainingSlots = maxFiles - uploadingFiles.length;
      const filesToProcess = fileArray.slice(0, remainingSlots);

      const newUploadingFiles: UploadingFile[] = filesToProcess.map((file) => {
        const error = validateFile(file);
        return {
          id: `${file.name}-${Date.now()}-${Math.random()}`,
          file,
          progress: 0,
          status: error ? 'error' : 'pending',
          error: error || undefined,
        };
      });

      setUploadingFiles((prev) => [...prev, ...newUploadingFiles]);

      // Upload valid files
      newUploadingFiles
        .filter((f) => !f.error)
        .forEach((uploadingFile) => {
          uploadFile(uploadingFile);
        });
    },
    [disabled, maxFiles, uploadingFiles.length, taskId, commentId]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!disabled) {
        setIsDragging(true);
      }
    },
    [disabled]
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles]
  );

  const handleClick = () => {
    if (!disabled) {
      inputRef.current?.click();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFiles(e.target.files);
    e.target.value = ''; // Reset input
  };

  const handleRemove = (id: string) => {
    setUploadingFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const getAcceptString = () => {
    if (accept) return accept.join(',');
    return ALLOWED_TYPES.join(',');
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const isUploading = uploadingFiles.some((f) => f.status === 'uploading');
  const canUpload = !disabled && !isUploading && uploadingFiles.length < maxFiles;

  return (
    <div className="w-full">
      {/* Upload Area */}
      <div
        onClick={handleClick}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`
          relative cursor-pointer rounded-lg border-2 border-dashed p-6
          transition-all duration-200
          ${
            isDragging
              ? 'border-blue-500 bg-blue-50'
              : canUpload
              ? 'border-zinc-300 hover:border-zinc-400 hover:bg-zinc-50'
              : 'border-zinc-200 bg-zinc-50 cursor-not-allowed'
          }
        `}
      >
        <input
          ref={inputRef}
          type="file"
          accept={getAcceptString()}
          onChange={handleInputChange}
          disabled={!canUpload}
          multiple
          className="hidden"
        />

        <div className="flex flex-col items-center gap-2 text-center">
          <div
            className={`rounded-full p-3 ${
              isDragging ? 'bg-blue-100 text-blue-600' : 'bg-zinc-100 text-zinc-500'
            }`}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
          </div>
          <div className="text-sm">
            {isDragging ? (
              <span className="text-blue-600 font-medium">松开以上传文件</span>
            ) : (
              <>
                <span className="font-medium text-zinc-700">点击上传</span>
                <span className="text-zinc-500"> 或拖拽文件到此处</span>
              </>
            )}
          </div>
          <div className="text-xs text-zinc-400">
            支持图片和文档，单个文件最大 10MB
          </div>
        </div>
      </div>

      {/* Uploading Files List */}
      {uploadingFiles.length > 0 && (
        <div className="mt-4 space-y-2">
          {uploadingFiles.map((file) => (
            <div
              key={file.id}
              className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white p-3"
            >
              {/* File Icon */}
              <div className="flex-shrink-0">
                {file.file.type.startsWith('image/') ? (
                  <div className="h-10 w-10 overflow-hidden rounded bg-zinc-100">
                    <img
                      src={URL.createObjectURL(file.file)}
                      alt={file.file.name}
                      className="h-full w-full object-cover"
                    />
                  </div>
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded bg-zinc-100">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-5 w-5 text-zinc-500"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                      />
                    </svg>
                  </div>
                )}
              </div>

              {/* File Info */}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-zinc-700">
                  {file.file.name}
                </div>
                <div className="text-xs text-zinc-500">
                  {formatFileSize(file.file.size)}
                </div>

                {/* Progress Bar or Status */}
                {file.status === 'uploading' && (
                  <div className="mt-1.5">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200">
                      <div
                        className="h-full rounded-full bg-blue-500 transition-all duration-300"
                        style={{ width: `${file.progress}%` }}
                      />
                    </div>
                    <div className="mt-0.5 text-xs text-zinc-500">{file.progress}%</div>
                  </div>
                )}
                {file.status === 'success' && (
                  <div className="mt-1 flex items-center gap-1 text-xs text-green-600">
                    <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                    上传成功
                  </div>
                )}
                {file.status === 'error' && (
                  <div className="mt-1 flex items-center gap-1 text-xs text-red-500">
                    <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                        clipRule="evenodd"
                      />
                    </svg>
                    {file.error || '上传失败'}
                  </div>
                )}
              </div>

              {/* Remove Button */}
              <button
                onClick={() => handleRemove(file.id)}
                className="flex-shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
