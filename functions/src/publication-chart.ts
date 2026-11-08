import QuickChart from 'quickchart-js';

const background = '#111827';
const ink = '#f1f5f9';
const axis = '#bac8db';
const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const colors = ['#60a5fa', '#fb923c', '#34d399', '#a78bfa', '#f472b6', '#facc15', '#22d3ee'];
const hours = Array.from({ length: 24 }, (_, hour) =>
    `${String(hour).padStart(2, '0')}:00-${String(hour + 1).padStart(2, '0')}:00`);
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
// Leave room for the text and queue metadata within Firestore's 1 MiB document limit.
const maxChartBytes = 900 * 1024;

export async function renderPublicationChart(
    publications: readonly (readonly number[])[],
    fetcher: typeof fetch = fetch,
): Promise<Buffer> {
    const datasets = publications.map((counts, index) => ({
        label: weekdays[index],
        data: counts,
        cubicInterpolationMode: 'monotone',
        borderColor: colors[index],
        backgroundColor: colors[index],
        pointBackgroundColor: colors[index],
        pointBorderColor: background,
        pointBorderWidth: 1.2,
        borderDash: index >= 5 ? [11, 7] : [],
        fill: false,
    }));
    const chart = new QuickChart()
        .setVersion('4')
        .setFormat('png')
        .setWidth(1040)
        .setHeight(680)
        .setDevicePixelRatio(2)
        .setBackgroundColor(background)
        .setConfig(JSON.stringify({
            type: 'line',
            data: { labels: hours, datasets },
            options: {
                animation: false,
                layout: { padding: { left: 34, right: 34, top: 20, bottom: 20 } },
                plugins: {
                    title: {
                        display: true, align: 'start', text: 'Публикации по часам',
                        color: ink, padding: { top: 8, bottom: 16 },
                        font: { size: 28, weight: 'bold' },
                    },
                    legend: {
                        position: 'top',
                        labels: { color: ink, usePointStyle: true, padding: 20, font: { size: 16, weight: 'semibold' } },
                    },
                    datalabels: { display: false },
                },
                scales: {
                    x: {
                        type: 'category',
                        title: { display: true, text: 'Время суток', color: axis, font: { size: 18, weight: 'semibold' } },
                        ticks: { color: axis, font: { size: 12 }, maxTicksLimit: 12, padding: 10 },
                        grid: { color: '#253348' },
                    },
                    y: {
                        beginAtZero: true, suggestedMax: 15,
                        title: { display: true, text: 'Опубликовано', color: axis, font: { size: 18, weight: 'semibold' } },
                        ticks: { color: axis, font: { size: 12 }, padding: 10 },
                        grid: { color: '#2c3a50' },
                    },
                },
            },
        }));

    // Apply an abort deadline to the SDK's request payload, including the download.
    const response = await fetcher('https://quickchart.io/chart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chart.getPostData()),
        signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`QuickChart returned HTTP ${response.status}`);
    const png = Buffer.from(await response.arrayBuffer());
    if (!png.subarray(0, pngSignature.length).equals(pngSignature)) throw new Error('QuickChart did not return a PNG');
    if (png.length > maxChartBytes) throw new Error('Publication chart exceeds the delivery queue size limit');
    return png;
}
