export class StorageError extends Error {
  name = this.constructor.name
}

export class InvalidFileTypeError extends StorageError {
  constructor(contentType: string) {
    super(`Invalid file type: ${contentType}. Allowed types: image/jpeg, image/png, image/webp, image/gif`)
  }
}

export class StorageConfigError extends StorageError {
  constructor(message: string) {
    super(message)
  }
}

export class StorageUploadError extends StorageError {
  constructor(message: string) {
    super(message)
  }
}
