// SPDX-License-Identifier: GPL-3.0-only
const fs = require('node:fs');
const path = require('node:path');

const MIN_WIDTH = 240;
const MIN_HEIGHT = 160;

function validBounds(bounds) {
  return bounds && ['x', 'y', 'width', 'height'].every(key =>
    Number.isInteger(bounds[key]) && bounds[key] >= -2147483648 && bounds[key] <= 2147483647
  ) && bounds.width >= MIN_WIDTH && bounds.height >= MIN_HEIGHT;
}

function readBounds(userData) {
  const file = path.join(userData, 'mini-window-bounds.json');
  try {
    const bounds = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!validBounds(bounds)) throw new Error('Invalid mini window bounds');
    return bounds;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('读取小窗位置和尺寸失败:', error);
    return null;
  }
}

function fitBounds(bounds, screen) {
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.max(MIN_WIDTH, Math.min(bounds.width, area.width));
  const height = Math.max(MIN_HEIGHT, Math.min(bounds.height, area.height));
  return {
    x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
    width,
    height
  };
}

function writeBounds(userData, bounds) {
  const file = path.join(userData, 'mini-window-bounds.json');
  const temporary = `${file}.tmp`;
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(bounds), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    console.error('保存小窗位置和尺寸失败:', error);
    try { fs.rmSync(temporary, { force: true }); } catch (cleanupError) {
      console.error('清理小窗设置临时文件失败:', cleanupError);
    }
  }
}

module.exports = { MIN_WIDTH, MIN_HEIGHT, readBounds, fitBounds, writeBounds };
