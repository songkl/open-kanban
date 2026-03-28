# 文件上传功能评估报告

## 1. 需求概述

在任务和评论中添加附件/图片上传功能。

## 2. 技术方案对比

### 方案 A: 本地文件存储（推荐初期使用）

**存储位置**: `kanban-go/uploads/` 目录

**优点**:
- 实现简单，无需外部依赖
- 无需额外费用
- 数据完全自主控制
- 适合小团队/个人使用

**缺点**:
- 单机存储，无法水平扩展
- 需要自行备份
- 大文件可能影响服务器性能

**适用场景**: 小团队、文件数量不多、预算有限

### 方案 B: 对象存储（OSS/S3/MinIO）

**存储位置**: 阿里云OSS / AWS S3 / 自建MinIO

**优点**:
- 可扩展性强
- 自动备份和CDN加速
- 减轻服务器压力
- 支持大文件

**缺点**:
- 需要额外成本
- 增加系统复杂度
- 需要处理外部依赖

**适用场景**: 大团队、文件数量多、需要高可用

## 3. 数据库设计

### 新增表: attachments

```sql
CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,           -- 原始文件名
    storage_path TEXT NOT NULL,       -- 存储路径（本地路径或对象存储key）
    storage_type TEXT DEFAULT 'local', -- local, oss, s3
    mime_type TEXT,                   -- 文件类型 image/png, application/pdf
    size INTEGER,                     -- 文件大小（字节）
    uploader_id TEXT,                 -- 上传者ID

    -- 关联信息（任务或评论）
    task_id TEXT,                     -- 关联的任务ID（可为空）
    comment_id TEXT,                  -- 关联的评论ID（可为空）

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
    FOREIGN KEY (uploader_id) REFERENCES users(id) ON DELETE SET NULL
);

-- 索引
CREATE INDEX idx_attachments_task ON attachments(task_id);
CREATE INDEX idx_attachments_comment ON attachments(comment_id);
```

## 4. API 设计

### 4.1 上传文件

```
POST /api/upload
Content-Type: multipart/form-data

Body:
- file: File (required) - 文件数据
- taskId: string (optional) - 关联的任务ID
- commentId: string (optional) - 关联的评论ID

Response 200:
{
  "id": "att_xxx",
  "filename": "screenshot.png",
  "url": "/api/uploads/att_xxx.png",
  "mimeType": "image/png",
  "size": 102400
}

Response 400:
{
  "error": "文件过大，最大支持10MB"
}
```

### 4.2 获取文件

```
GET /api/uploads/:attachmentId

Response: 文件流 (Content-Type: image/png 等)
```

### 4.3 删除附件

```
DELETE /api/attachments/:id

Response 204: No Content
```

### 4.4 获取任务附件列表

```
GET /api/tasks/:taskId/attachments

Response:
[
  {
    "id": "att_xxx",
    "filename": "screenshot.png",
    "url": "/api/uploads/att_xxx.png",
    "mimeType": "image/png",
    "size": 102400,
    "createdAt": "2026-03-27T10:00:00Z"
  }
]
```

## 5. 后端实现要点

### 5.1 依赖包

```go
// go.mod 添加
github.com/google/uuid v1.6.0  // 生成唯一ID
```

### 5.2 配置项

```go
// config.go
type UploadConfig struct {
    MaxFileSize    int64  // 最大文件大小（默认10MB）
    AllowedTypes   []string // 允许的文件类型
    StoragePath    string // 本地存储路径（默认./uploads）
    StorageType    string // local, oss, s3
}
```

### 5.3 文件处理流程

1. **验证**: 检查文件大小、类型
2. **生成ID**: 使用 uuid 生成唯一标识
3. **保存文件**:
   - 本地: `uploads/2025/03/att_xxx.png`
   - OSS: 上传至对象存储
4. **记录数据库**: 插入 attachments 表
5. **返回信息**: 返回文件URL和元数据

### 5.4 安全考虑

- **文件类型白名单**: 只允许图片(jpg/png/gif/webp)和常见文档(pdf/doc/docx/xls/xlsx/txt)
- **文件大小限制**: 默认10MB，可配置
- **文件名处理**: 使用随机ID存储，防止路径遍历攻击
- **权限检查**: 验证用户是否有权上传/删除

## 6. 前端实现要点

### 6.1 组件设计

```typescript
// FileUpload.tsx - 文件上传组件
interface FileUploadProps {
  taskId?: string;
  commentId?: string;
  onUpload: (files: Attachment[]) => void;
  maxFiles?: number;
}

// AttachmentList.tsx - 附件列表组件
interface AttachmentListProps {
  attachments: Attachment[];
  onDelete?: (id: string) => void;
  canDelete?: boolean;
}

// ImagePreview.tsx - 图片预览组件
interface ImagePreviewProps {
  src: string;
  alt: string;
}
```

### 6.2 API 封装

```typescript
// services/api.ts 添加
export const attachmentsApi = {
  upload: (file: File, options?: { taskId?: string; commentId?: string }) => {
    const formData = new FormData();
    formData.append('file', file);
    if (options?.taskId) formData.append('taskId', options.taskId);
    if (options?.commentId) formData.append('commentId', options.commentId);

    return fetchApi<Attachment>('/api/upload', {
      method: 'POST',
      body: formData,
      // 不要设置 Content-Type，让浏览器自动设置
    });
  },

  delete: (id: string) =>
    fetchApi<void>(`/api/attachments/${id}`, { method: 'DELETE' }),

  getByTask: (taskId: string) =>
    fetchApi<Attachment[]>(`/api/tasks/${taskId}/attachments`),
};
```

### 6.3 拖拽上传示例

```tsx
// 使用 react-dropzone 或原生实现
const { getRootProps, getInputProps } = useDropzone({
  accept: {
    'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp'],
    'application/pdf': ['.pdf'],
  },
  maxSize: 10 * 1024 * 1024, // 10MB
  onDrop: async (files) => {
    for (const file of files) {
      await attachmentsApi.upload(file, { taskId });
    }
  },
});
```

## 7. 任务拆分建议

根据评估，建议拆分为以下子任务：

### 后端任务
1. **数据库迁移**: 创建 attachments 表
2. **上传接口**: POST /api/upload 实现
3. **文件服务**: GET /api/uploads/:id 实现
4. **附件管理**: DELETE /api/attachments/:id 实现
5. **任务附件查询**: GET /api/tasks/:taskId/attachments 实现

### 前端任务
1. **文件上传组件**: FileUpload 组件开发
2. **附件列表组件**: AttachmentList 组件开发
3. **任务详情集成**: TaskModal 中添加附件上传和展示
4. **评论集成**: 评论区域支持附件上传

## 8. 推荐实现顺序

1. **Phase 1**: 基础功能
   - 本地存储实现
   - 图片上传支持
   - 任务详情页集成

2. **Phase 2**: 增强功能
   - 评论附件支持
   - 更多文件类型支持
   - 拖拽上传

3. **Phase 3**: 可选功能
   - 对象存储支持
   - 图片压缩/缩略图
   - 批量上传

## 9. 预估工时

| 模块 | 后端 | 前端 | 测试 |
|------|------|------|------|
| Phase 1 | 4h | 6h | 2h |
| Phase 2 | 2h | 4h | 1h |
| Phase 3 | 4h | 4h | 2h |
| **总计** | **10h** | **14h** | **5h** |

## 10. 结论

文件上传功能**可行且必要**。建议采用**方案A（本地存储）**作为MVP实现，后续根据需求升级到对象存储。

下一步：创建前后端具体开发任务。
