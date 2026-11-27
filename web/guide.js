const controls = document.getElementById('guide-quantity');
const buttons = controls.querySelectorAll('button');
const lots = Array.from(document.querySelectorAll('.guide-lots li'), (lot) => ({
  lot,
  price: Number(lot.dataset.price),
  stock: Number(lot.dataset.stock),
  bought: lot.querySelector('small'),
}));
const count = document.getElementById('guide-quantity-count');
const total = document.getElementById('guide-quantity-total');
const average = document.getElementById('guide-quantity-average');
const format = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });

for (const button of buttons) {
  button.addEventListener('click', () => {
    const quantity = Number(button.dataset.quantity);
    let remaining = quantity;
    let cost = 0;
    for (const { lot, price, stock, bought } of lots) {
      const used = Math.min(stock, remaining);
      cost += used * price;
      remaining -= used;
      lot.classList.toggle('is-used', used > 0);
      bought.textContent = `구매 ${used}개`;
    }
    count.textContent = quantity;
    total.textContent = `${format.format(cost)}골드`;
    average.textContent = `${format.format(cost / quantity)}골드`;
    buttons.forEach((option) => option.setAttribute('aria-pressed', String(option === button)));
  });
}
controls.hidden = false;
