import { homedir } from 'node:os'
import { join, win32 } from 'node:path'

export function dataDirectory({ platform = process.platform, home = homedir(), appData = process.env.APPDATA } = {}) {
  if (platform === 'win32') return win32.join(appData || win32.join(home, 'AppData', 'Roaming'), 'ASTaria')
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'ASTaria')
  return join(home, '.local', 'share', 'ASTaria')
}
