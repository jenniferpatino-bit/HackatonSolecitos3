export type Permission =
  | 'files:read'
  | 'files:refine'
  | 'refiners:read'
  | 'refiners:write'
  | 'media:upload'
  | 'incidents:read'
  | 'incidents:create'
  | 'team:manage'

export interface Me {
  id: number
  email: string
  displayName: string
  team: { code: string; name: string }
  role: { code: string; name: string }
  permissions: Permission[]
  clearance: { granted: boolean; grantedAt: string | null }
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

export interface Page<T> {
  content: T[]
  totalElements: number
  totalPages: number
  page: number
  size: number
}

export type Bin = 'WO' | 'FC' | 'DR' | 'MA'
export const BINS: Bin[] = ['WO', 'FC', 'DR', 'MA']

export type Progress = Record<Bin | 'overall', number>

export interface FileInfo {
  id: number
  name: string
  rows: number
  cols: number
  tileSize: number
  status: 'ACTIVE' | 'COMPLETE'
  progress: Progress
  refinedGroups: number
  totalGroups: number
  mistakes: number
  updatedAt: string
}

export interface Rules {
  tremorThreshold: number
  connectivity: 4 | 8
  minGroupSize: number
  maxGroupSize: number
  binning: { strategy: 'DIGIT_SUM_MOD' | 'MAX_DIGIT_MOD'; order: Bin[] }
}

export interface TileDto {
  tileRow: number
  tileCol: number
  originRow: number
  originCol: number
  rows: number
  cols: number
  values: string
  tremor: string
  bins: string
  version: number
}

export interface CellRef {
  r: number
  c: number
}

export interface RefineResult {
  refinementId: number
  bin: Bin
  size: number
  file: Pick<FileInfo, 'progress' | 'refinedGroups' | 'totalGroups' | 'mistakes' | 'status'>
}

export interface Check {
  name: string
  passed: boolean
  detail: string
}

export interface IntegrationStatus {
  deploy: {
    origin: string | null
    verifiedAt: string | null
    lastBuildSeen: string | null
    lastBuildSeenAt: string | null
    pendingChallenge: unknown
  }
  storage: { provider: string | null; verifiedAt: string | null; checks: Check[]; config: unknown }
  clearance: { granted: boolean; grantedAt: string | null }
}

export interface RosterMember {
  name: string
  code: string
}

export interface Roster {
  members: RosterMember[]
  complete: boolean
  locked: boolean
}

export interface Clearance {
  granted: boolean
  grantedAt: string | null
  checks: Check[]
  checkedAt: string | null
  workspace: { kind: 'DEV' | 'EVAL'; chaosLevel: 0 | 1 | 2 }
  roster: Roster
  round: { approved: boolean; nextRoundAt: string | null; drawnMember: unknown }
}

export interface DeployChallenge {
  origin: string
  token: string
  wellKnownPath: string
  expiresAt: string
}

export interface Department {
  id: number
  code: string
  name: string
}

export interface Refiner {
  id: number
  fullName: string
  department: Department
  title: string
  extension: string
  bio: string
  profileUrl: string | null
  badge: { url: string; width?: number; height?: number; mediaId?: number } | null
  version: number
  updatedAt: string
}

export interface MediaTicket {
  ticketId: string
  expiresAt: string
  provider: 'SUPABASE' | 'CLOUDINARY'
  objectPath?: string
  bucket?: string
  uploadPublicId?: string
  expectedPublicId?: string
}

export interface Media {
  mediaId: number
  url: string
  width: number
  height: number
  purpose: 'BADGE' | 'INCIDENT'
}

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export interface Incident {
  id: number
  title: string
  description: string
  severity: Severity
  fileId: number | null
  file: { id: number; name: string } | null
  photos: { mediaId: number; url: string; width: number; height: number }[]
  createdBy: { id: number; displayName: string }
  createdAt: string
}

export interface StreamTicket {
  ticket: string
  expiresIn: number
}

export interface EventMap {
  'refiner.updated': {
    id: number
    version: number
    changes: string[]
    refiner: Refiner
    updatedBy: { userId: number | null; displayName: string }
  }
  'refinement.created': {
    fileId: number
    refinementId: number
    cells: CellRef[]
    bin: Bin
    progress: Progress
    refinedBy: { userId: number; displayName: string }
  }
  'file.completed': { fileId: number; name: string }
  'contingency.activated': { id: number; userId: number; status: 'ACTIVE'; createdAt: string; message: string }
  'contingency.resolved': { id: number; userId: number; ackedAt: string }
  'session.revoked': { reason: 'LOGOUT' | 'REFRESH_REUSED' }
  'stream.reset': { reason: string; message: string }
  'stream.superseded': { message: string }
}
