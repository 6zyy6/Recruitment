export function parseCsv(source: string): Record<string, string>[] {
  if (new TextEncoder().encode(source).length > 5 * 1024 * 1024)
    throw new Error("CSV 文件不能超过 5 MiB");
  const input = source.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    afterQuote = false;
  const finishCell = () => {
    row.push(cell.trim());
    cell = "";
    afterQuote = false;
  };
  const finishRow = () => {
    finishCell();
    if (row.some(Boolean)) rows.push(row);
    row = [];
  };
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
        afterQuote = true;
      } else cell += char;
    } else if (char === '"') {
      if (cell || afterQuote) throw new Error("CSV 引号格式错误");
      quoted = true;
    } else if (char === ",") finishCell();
    else if (char === "\r" || char === "\n") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      finishRow();
    } else if (afterQuote && char.trim())
      throw new Error("CSV 闭合引号后出现非法字符");
    else if (!afterQuote) cell += char;
  }
  if (quoted) throw new Error("CSV 中存在未闭合的引号");
  if (cell || row.length) finishRow();
  if (rows.length < 2) throw new Error("CSV 必须包含表头和至少一行数据");
  if (rows.length > 1001) throw new Error("每次最多导入 1,000 行数据");
  const aliases: Record<string, string> = {
    姓名: "name",
    邮箱: "email",
    手机: "phone",
    手机号: "phone",
    学校: "school",
    院校: "school",
    专业: "major",
    毕业年份: "graduationYear",
    技能: "skills",
    学历: "education",
    最高学历: "education",
    简历: "resume",
    到岗时间: "availability",
    渠道: "source",
  };
  const headers = rows[0].map((h) => aliases[h] || h);
  if (new Set(headers).size !== headers.length)
    throw new Error("CSV 存在重复表头");
  if (
    !headers.includes("name") ||
    (!headers.includes("email") && !headers.includes("phone"))
  )
    throw new Error(
      "CSV 需要 name（姓名）和 email（邮箱）或 phone（手机）表头",
    );
  return rows.slice(1).map((values, i) => {
    if (values.length !== headers.length)
      return {
        __parseError: `第 ${i + 2} 行列数与表头不一致`,
        ...Object.fromEntries(
          headers.map((h, index) => [h, values[index] ?? ""]),
        ),
      };
    return Object.fromEntries(headers.map((h, index) => [h, values[index]]));
  });
}
