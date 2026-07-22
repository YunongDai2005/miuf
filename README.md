# Berlin Trace

在柏林地图上像在纸质地图上一样落下图钉，用丝线串起景点和拐点，再从 VBB 在指定日期和时间真实可乘的行程中找出最贴近轨迹的公共交通方案。

## 功能

- 点击景点图钉或地图空白处逐段拉线，实时显示下一段丝线预览
- 空白处会生成可拖动拐点，并记录每个节点的名称与经纬度
- 节点自动保存在当前设备，也可通过键盘在地图中心落钉、完成或撤销
- 查询 VBB 行程规划接口，验证班次、方向、步行接驳和换乘在当时确实可行
- 使用有序轨迹距离为真实候选排序，而不是把附近线路直接当成乘车结果
- 长距离、多转折轨迹会拆成有序检查点，逐段按真实到达时间继续查询
- 相似度或轨迹覆盖不足的结果会直接拒绝，不展示“虽然可乘但与轨迹无关”的路线
- 支持 U-Bahn、S-Bahn、Tram、Bus、区域列车和渡轮
- 显示发到时间、方向、上下车站、换乘、实时延误和多个候选
- VBB 接口不可用时明确降级为离线几何估算
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

## 数据来源

真实可乘行程由 [`v6.vbb.transport.rest`](https://v6.vbb.transport.rest/) 提供；页面会直接查询 `/journeys`，请求 stopovers 与 polylines，并按手绘轨迹排序。

## 离线数据更新

离线降级所需的线路和站点来自 VBB GTFS，许可为 CC BY 4.0。下载最新的官方 GTFS ZIP 后运行：

```bash
python3 scripts/build-berlin-transit.py /path/to/GTFS.zip
```

生成脚本会保留服务柏林站点的线路，压缩线路几何，并写入 `public/berlin-transit.json`。
