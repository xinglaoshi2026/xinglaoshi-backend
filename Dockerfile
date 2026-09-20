# 云端同步后端镜像（零依赖，纯 Python 标准库）
FROM python:3.11-slim
WORKDIR /app
COPY . /app
EXPOSE 10000
CMD ["python", "server.py"]
