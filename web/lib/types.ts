// Types and constants shared by server and client code. No server imports here.

export type Role = "owner" | "admin" | "member";
export type Privacy = "link" | "workspace" | "private";
export type VideoStatus = "recording" | "ready" | "failed";
export type Access = "owner" | "member" | "invited" | "link";
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
  durationMs: number | null;
  size: number | null;
  views: number;
  createdAt: number;
  archived: boolean;
  owner: { id: string; name: string; email: string; avatarUrl: string | null };
  videoUrl: string | null;
  downloadUrl: string | null;
  thumbUrl: string | null;
};

export type Member = { id: string; name: string; email: string; role: Role; avatarPath: string | null; joinedAt: number; videos: number };

export type Invite = { id: string; role: Role; uses: number; maxUses: number | null; expiresAt: number | null; createdAt: number; createdBy: string | null };
