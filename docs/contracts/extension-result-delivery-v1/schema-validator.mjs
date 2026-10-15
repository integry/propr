// Deliberately small, fail-closed interpreter for this bundle's pinned JSON Schema.
export function valid(s, v) {
  if (s.not && valid(s.not, v)) return false;
  if (s.oneOf && s.oneOf.filter(x => valid(x, v)).length !== 1) return false;
  if (s.anyOf && !s.anyOf.some(x => valid(x, v))) return false;
  if (s.const !== undefined && v !== s.const) return false;
  if (s.enum && !s.enum.includes(v)) return false;
  if (s.type === 'null' && v !== null) return false;
  if (s.type === 'object') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    if (s.required?.some(k => !Object.hasOwn(v, k))) return false;
    if (s.maxProperties !== undefined && Object.keys(v).length > s.maxProperties) return false;
    for (const [k, value] of Object.entries(v)) {
      if (s.propertyNames && !valid(s.propertyNames, k)) return false;
      const child = s.properties && Object.hasOwn(s.properties, k) ? s.properties[k] : s.additionalProperties;
      if (child === false || (child && child !== true && !valid(child, value))) return false;
    }
  }
  if (s.type === 'array') {
    if (!Array.isArray(v) || (s.minItems !== undefined && v.length < s.minItems) || (s.maxItems !== undefined && v.length > s.maxItems)) return false;
    for (let i = 0; i < v.length; i++) {
      const child = s.prefixItems?.[i] ?? s.items;
      if (child === false || (child && child !== true && !valid(child, v[i]))) return false;
    }
  }
  if (s.type === 'string' && (typeof v !== 'string' || (s.pattern && !new RegExp(s.pattern).test(v))
    || (s.minLength !== undefined && v.length < s.minLength) || (s.maxLength !== undefined && v.length > s.maxLength))) return false;
  if ((s.type === 'integer' || s.type === 'number') && (typeof v !== 'number' || !Number.isSafeInteger(v)
    || (s.minimum !== undefined && v < s.minimum) || (s.maximum !== undefined && v > s.maximum)
    || (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum))) return false;
  if (s.type === 'boolean' && typeof v !== 'boolean') return false;
  return true;
}
