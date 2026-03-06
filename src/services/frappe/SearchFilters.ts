// https://docs.frappe.io/erpnext/v14/user/manual/en/using-erpnext/search-filter
enum FilterOp {
  Eq = "=",
  Neq = "!=",
  Gt = ">",
  Lt = "<",
  Gte = ">=",
  Lte = "<=",
  Like = "like",
  NotLike = "not like",
  In = "in",
  NotIn = "not in",
  Between = "between",
  Is = "is",
}

export type Filter = {
  operator: FilterOp
  value: string | string[]
}

export const SearchFilter = {
  Eq: (val: string): Filter => ({ operator: FilterOp.Eq, value: val }),
  In: (...vals: string[]): Filter => ({ operator: FilterOp.In, value: vals }),
}
