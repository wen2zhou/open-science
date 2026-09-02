import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, rename, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

type PrismaClientCheck = (options: {
  root?: string
  schemaPath?: string
  clientSchemaPath?: string
}) => void

const sourceSchemaPath = (root: string): string => join(root, 'prisma', 'schema.prisma')

export const prismaClientSnapshotPath = (root = resolve('.')): string => {
  const schema = readFileSync(sourceSchemaPath(root))
  const fingerprint = createHash('sha256').update(schema).digest('hex').slice(0, 16)
  return join(root, '.vitest', `prisma-client-${fingerprint}`)
}

export const prismaClientRuntimeAlias = (
  root = resolve('.')
): { find: RegExp; replacement: string } => ({
  // Keep this exact: generated code imports @prisma/client/runtime/* from the shared, immutable
  // package while only the schema-specific generated entry point comes from the snapshot.
  find: /^@prisma\/client$/,
  replacement: join(prismaClientSnapshotPath(root), 'index.js')
})

export const ensurePrismaClientSnapshot = async (root = resolve('.')): Promise<string> => {
  const source = join(root, 'node_modules', '.prisma', 'client')
  const destination = prismaClientSnapshotPath(root)
  const schemaPath = sourceSchemaPath(root)
  const { checkPrismaClient } = (await import('../scripts/check-prisma-client.mjs')) as {
    checkPrismaClient: PrismaClientCheck
  }
  const verify = (clientRoot: string): void =>
    checkPrismaClient({ schemaPath, clientSchemaPath: join(clientRoot, 'schema.prisma') })

  try {
    verify(destination)
    return destination
  } catch {
    // An interrupted earlier copy is never reused.
    await rm(destination, { recursive: true, force: true })
  }

  // Verify the shared install before copying. Worktrees intentionally symlink node_modules to the
  // main checkout, where another checkout can run prisma generate concurrently.
  verify(source)
  await mkdir(join(root, '.vitest'), { recursive: true })
  const temporary = `${destination}.copy-${process.pid}-${randomUUID()}`
  try {
    await cp(source, temporary, { recursive: true, errorOnExist: true })
    // Detect a generate that raced the copy instead of publishing a mixed client snapshot.
    verify(temporary)
    try {
      await rename(temporary, destination)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
      verify(destination)
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  return destination
}

export default async function setupPrismaClientIsolation(): Promise<void> {
  await ensurePrismaClientSnapshot()
}
