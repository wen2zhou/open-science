const decodeManagedRemoteUriPath = (uri: string): string => {
  const pathname = decodeURIComponent(new URL(uri).pathname)
  return pathname.startsWith('/~/') ? pathname.slice(1) : pathname
}

export { decodeManagedRemoteUriPath }
