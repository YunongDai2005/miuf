# Berlin Trace

在柏林地图上手绘一段历史行动轨迹，推测可能乘坐的公共交通线路、上下车站和换乘顺序。

## 功能

- 自由手绘或键盘绘制历史轨迹
- 连续分段推断，避免只返回零散的相近线路
- 支持 U-Bahn、S-Bahn、Tram、Bus、区域列车和渡轮
- 显示可能的上下车站、换乘点、置信度及同路廊候选
- 仅处理柏林范围内的线路与站点

## 本地开发

```bash
npm install
npm run dev
```

验证：

```bash
npm test
npm run lint
npx tsc --noEmit
```

## 数据更新

线路和站点来自 VBB GTFS，许可为 CC BY 4.0。下载最新的官方 GTFS ZIP 后运行：

```bash
python3 scripts/build-berlin-transit.py /path/to/GTFS.zip
```

生成脚本会保留服务柏林站点的线路，压缩线路几何，并写入 `public/berlin-transit.json`。
