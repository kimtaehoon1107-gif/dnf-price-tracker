// 공식 목록의 날짜와 제목에 명시된 적용일만 사용한다. 날짜 추정은 하지 않는다.
export const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
export function updateRows(html: string) {
  return [...html.matchAll(/<ul[^>]*>[\s\S]*?<li class="category">([\s\S]*?)<\/li>[\s\S]*?<li class="title"[^>]*data-no="(\d+)"[^>]*>([\s\S]*?)<div class="iconset">[\s\S]*?<li class="date">\s*(\d{4}\.\d{2}\.\d{2})/g)].map(m => {
    const title = text(m[3]), publishedDate = m[4].replaceAll('.', '-');
    const explicit = title.match(/(\d{1,2})\/(\d{1,2})\([월화수목금토일]\)/);
    let date = publishedDate;
    if (explicit) {
      let year = +publishedDate.slice(0, 4);
      if (+explicit[1] === 1 && publishedDate.slice(5, 7) === '12') year++;
      date = `${year}-${explicit[1].padStart(2,'0')}-${explicit[2].padStart(2,'0')}`;
    }
    return { id: m[2], category: text(m[1]), title, publishedDate, date, dateBasis: explicit ? '적용일 · 제목 명시' : '공지 게시일 · 적용일 미확인', url: `https://df.nexon.com/community/news/update/${m[2]}` };
  });
}
export function updateHeadings(html: string) {
  const body = html.split('<div class="bd_viewcont">')[1]?.split('<article class="bdview_btnarea')[0] ?? '';
  return [...new Set([...body.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g), ...body.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/g)].map(m => text(m[1])).filter(Boolean))].slice(0, 8);
}
