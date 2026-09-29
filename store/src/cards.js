// Renders mock course cards: <div data-cards='[[short, name, countdown|null, tier, count], ...]'>
document.querySelectorAll("[data-cards]").forEach((row) => {
  for (const [short, name, due, tier, count] of JSON.parse(row.dataset.cards)) {
    row.insertAdjacentHTML("beforeend", `
      <div class="card">
        <h3>${short}</h3>
        <div class="name">${name}</div>
        <div class="info">${due
          ? `<div>Next assignment:</div><mark>${due}</mark>`
          : `<mark class="none">No upcoming assignments</mark>`}</div>
        <img src="../../images/tier${tier}.png" alt="">
        <div class="bar"><span>${count} assignments</span><button>See Grade</button></div>
      </div>`);
  }
});
