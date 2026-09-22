import { badRequest } from "./errors.js";

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireObject(value, label) {
  if (!isPlainObject(value)) {
    throw badRequest(`${label}必须是 JSON 对象`);
  }
  return value;
}

export function requireString(obj, field) {
  const value = obj[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest(`字段 ${field} 必须是非空字符串`);
  }
  return value.trim();
}

export function optionalString(obj, field) {
  const value = obj[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest(`字段 ${field} 必须是非空字符串`);
  }
  return value.trim();
}

export function requirePositiveInt(obj, field) {
  const value = obj[field];
  if (!Number.isInteger(value) || value <= 0) {
    throw badRequest(`字段 ${field} 必须是正整数（最小发放单位）`);
  }
  return value;
}

export function requireNonNegativeInt(obj, field) {
  const value = obj[field];
  if (!Number.isInteger(value) || value < 0) {
    throw badRequest(`字段 ${field} 必须是非负整数（最小发放单位）`);
  }
  return value;
}

export function optionalBoolean(obj, field, fallback) {
  const value = obj[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw badRequest(`字段 ${field} 必须是布尔值`);
  }
  return value;
}

export function requireIsoTimestamp(obj, field) {
  const value = requireString(obj, field);
  if (Number.isNaN(Date.parse(value))) {
    throw badRequest(`字段 ${field} 必须是带时区的 ISO 8601 时间`);
  }
  return new Date(value).toISOString();
}

export function optionalIsoTimestamp(obj, field) {
  const value = obj[field];
  if (value === undefined || value === null) return null;
  return requireIsoTimestamp(obj, field);
}

export function requireArray(obj, field, { minLength = 1 } = {}) {
  const value = obj[field];
  if (!Array.isArray(value) || value.length < minLength) {
    throw badRequest(`字段 ${field} 必须是至少包含 ${minLength} 项的数组`);
  }
  return value;
}
