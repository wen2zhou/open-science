type SpecialistArchiveDialog = {
  showOpenDialog: (options: {
    properties: ['openFile']
    filters: [{ name: 'Specialist ZIP'; extensions: ['zip'] }]
  }) => Promise<{ canceled: boolean; filePaths: string[] }>
  readFile: (path: string) => Promise<Uint8Array>
}

export const selectSpecialistArchive = async (
  adapter: SpecialistArchiveDialog
): Promise<{ cancelled: true } | { bytes: Uint8Array }> => {
  const selected = await adapter.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Specialist ZIP', extensions: ['zip'] }]
  })
  if (selected.canceled || selected.filePaths.length !== 1) return { cancelled: true }
  return { bytes: new Uint8Array(await adapter.readFile(selected.filePaths[0])) }
}
