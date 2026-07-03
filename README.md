# code-sandbox
代码沙箱

# build
docker build -f ./docker/Dockerfile -t sandbox-for-me:v1 backend/sandbox

# run
docker run -p 8126:8126 --name sandbox sandbox-for-me:v1

# clean
docker rm -f sandbox