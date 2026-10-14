/** Where the notices file lives in the source tree (and, unpacked, in a build). */
export const NOTICES_PATH: string
/** Where the same notices live as a list, with the GPL's text, for Settings ▸ About. */
export const LIST_PATH: string
/** Both outputs as `bin/notices` would write them now: the notices file, and the list as JSON. */
export function buildNotices(): { text: string; list: string }
