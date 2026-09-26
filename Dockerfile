# 云端同步后端镜像
FROM python:3.11-slim
WORKDIR /app
# R2 对象存储(boto3) + 图片压缩(Pillow)；未配置 R2 时自动回退本地磁盘
RUN pip install --no-cache-dir boto3 Pillow
COPY . /app
EXPOSE 10000
CMD ["python", "server.py"]
