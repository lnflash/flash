export class StorageError extends Error {
  name = this.constructor.name
}

export class InvalidFileTypeError extends StorageError {
  constructor(contentType: string) {
    super(`Invalid file type: ${contentType}. Allowed: image/jpeg, image/png, image/webp`)
  }
}
