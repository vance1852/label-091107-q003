export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message) => new ApiError(400, "bad_request", message);
export const notFound = (message) => new ApiError(404, "not_found", message);
export const conflict = (message) => new ApiError(409, "conflict", message);
