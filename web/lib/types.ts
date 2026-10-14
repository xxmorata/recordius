// Types and constants shared by server and client code. No server imports here.

export type Role = "owner" | "admin" | "member";
export type Privacy = "link" | "workspace" | "private";
export type VideoStatus = "recording" | "ready" | "failed";
export type Access = "owner" | "member" | "invited" | "link";
export type VideoSource = "recording" | "upload";
export type LibraryScope = "mine" | "workspace" | "archive";

export const PRIVACY_LABELS: Record<Privacy, { title: string; description: string }> = {
  link: { title: "Anyone with the link", description: "No sign-in needed. Only people you send the link to can find it." },
  workspace: { title: "Workspace members", description: "Everyone in your workspace can watch and see it in the library." },
  private: { title: "Only you and invited people", description: "Only you and the people you invite by email." },
};

/** What pages and the API expose. URLs are presigned and expire; they are only filled in for allowed viewers. */
export type Video = {
  id: string;
  title: string;
  status: VideoStatus;
  privacy: Privacy;
  mimeType: string;
  /** Length people watch: the trimmed length when a trim is set. */
  durationMs: number | null;
  /** Length of the file itself. */
  originalDurationMs: number | null;
  trim: { startMs: number; endMs: number } | null;
  source: VideoSource;
  /** Link-sharing extras (only meaningful when privacy is "link"). Owners see these; viewers never get the password. */
  link: { hasPassword: boolean; expiresAt: number | null };
  size: number | null;
  views: number;
  createdAt: number;
  archived: boolean;
  owner: { id: string; name: string; email: string; avatarUrl: string | null };
  videoUrl: string | null;
  downloadUrl: string | null;
  /** Whether this viewer may download the file (lists leave downloadUrl empty and use /api/videos/:id/download). */
  canDownload: boolean;
  thumbUrl: string | null;
  /**
   * Whether the file has a seek index. Recordings from desktop apps before 1.0.14 don't; the server adds
   * one in the background ("pending" → "ready"). Until then Firefox can't jump ahead in them.
   */
  seekIndex: "pending" | "ready" | "failed";
};

export type Viewer = { name: string; email: string; avatarUrl: string | null; percent: number; lastSeenAt: number };
export type ViewerStats = { viewers: Viewer[]; anonymous: { count: number; avgPercent: number }; total: number };

export type Member = { id: string; name: string; email: string; role: Role; avatarPath: string | null; joinedAt: number; videos: number };

export type Invite = { id: string; role: Role; uses: number; maxUses: number | null; expiresAt: number | null; createdAt: number; createdBy: string | null };

export type Comment = {
  id: string;
  body: string;
  atMs: number | null;
  createdAt: number;
  author: { id: string; name: string; avatarUrl: string | null };
  canDelete: boolean;
};
